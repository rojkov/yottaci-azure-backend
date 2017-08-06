#!/usr/bin/env python3

import asyncio
import logging
import os
import shutil
import tempfile
import tarfile
import json
import base64
import time

import jwt
import yaml

from urllib.parse import urlparse
from http.client import HTTPSConnection

from tempfile import NamedTemporaryFile

from azure.storage.blob.models import ContentSettings
from azure.storage.blob import AppendBlobService
from azure.storage.queue import QueueService
from azure.storage.blob.models import PublicAccess
from github import Github

LOG = logging.getLogger(__name__)


TASKDATA = "/etc/taskdata.json"
WORKDIR = "/data/cibot"
FILESHARE = "/fileshare"
REPOSDIR = os.path.join(FILESHARE, "gitrepos")
LOGDIR = os.path.join(FILESHARE, "logs")
LOCKFILENAME = os.path.join(REPOSDIR, "cibot-git.lock")
BBCACHE = os.path.join(FILESHARE, "bb-cache")
SRCDIR = os.path.join(WORKDIR, "deleteme")
AUTOCONFIG = """
DL_DIR = "%s"
SSTATE_DIR = "%s"
""" % (os.path.join(BBCACHE, "downloads"), os.path.join(SRCDIR, "sstate"))
BUILDSCRIPT = """
source git.openembedded.org.openembedded-core/oe-init-build-env build git.openembedded.org.bitbake
%s
#bitbake core-image-ros-world
bitbake %s
"""

def get_sstate_archive_path(ctx):
    """Returns path to sstate archive for given configuration."""
    confname = ctx.config.get("configuration_name",
                              "configuration%s" % ctx.taskdata["config_num"])
    return os.path.join(BBCACHE, "sstate-%s.tar.gz" % confname)

class Context(object):
    """Program context."""

    def __init__(self, loop, config, blob_service,
                 queue_service, taskdata):
        self.pid = "%s-%s" % (taskdata["pid"], taskdata["config_num"])
        self.loop = loop
        self.config = config
        self.blob_service = blob_service
        self.queue_service = queue_service
        self.taskdata = taskdata

class CommandLineProtocol(asyncio.SubprocessProtocol):

    def __init__(self, exit_future, pid, blob_service):
        self.exit_future = exit_future
        self.blob_service = blob_service
        self.transport = None
        self.pid = pid

    def connection_made(self, transport):
        self.transport = transport

    def pipe_data_received(self, fd, data):
        print(data.decode('ascii').rstrip())
        self.blob_service.append_blob_from_bytes("logs", self.pid, data)

    def process_exited(self):
        self.exit_future.set_result(self.transport.get_returncode())
        self.transport.close()

@asyncio.coroutine
def run_command(ctx, cmd, cwd):
    exit_future = asyncio.Future(loop=ctx.loop)
    proto_factory = lambda: CommandLineProtocol(exit_future, ctx.pid, ctx.blob_service)
    proc_coro = ctx.loop.subprocess_exec(proto_factory, *cmd, stdin=None, cwd=cwd)
    transport, protocol = yield from proc_coro
    result = yield from exit_future
    return result

def run(ctx, cmd, cwd, save_sstate_flag=False):
    result = ctx.loop.run_until_complete(run_command(ctx, cmd, cwd))
    if result != 0:
        github = GithubAdapter(ctx.taskdata)
        gh_commit = github.get_commit()
        gh_commit.create_status("failure",
                                target_url=ctx.blob_service.make_blob_url("logs",
                                                                          ctx.pid),
                                description="Build failed",
                                context=ctx.config.get("configuration_name", "configuration%s" % ctx.taskdata["config_num"]))
        if save_sstate_flag:
            save_sstate(ctx)

        ctx.taskdata["build_result"] = "failure"
        ctx.queue_service.put_message("buildresults", base64.b64encode(json.dumps(ctx.taskdata).encode("utf")).decode("utf"))
        cloudlog_dir = os.path.join(LOGDIR, ctx.pid)
        os.makedirs(cloudlog_dir, exist_ok=True)
        shutil.copyfile("/var/log/cloud-init-output.log", os.path.join(cloudlog_dir,
                                                                       "cloud-init-output.log"))
        shutil.copyfile("/var/log/cloud-init.log", os.path.join(cloudlog_dir,
                                                                "cloud-init.log"))
        raise RuntimeError("Failed to run '%s'" % " ".join(cmd))

def run_script(ctx, script, cwd):
    with NamedTemporaryFile(mode="w") as scriptfile:
        scriptfile.write(script)
        scriptfile.flush()
        return run(ctx, ["/bin/bash", "-xe", scriptfile.name], cwd, save_sstate_flag=True)

def save_sstate(ctx):
    # Save sstate for future use
    fd, tmpfile = tempfile.mkstemp(dir=BBCACHE, prefix="sstatearch")
    with os.fdopen(fd, "wb") as stream:
        with tarfile.open(fileobj=stream, mode="w:gz") as sstatetmp:
            sstatetmp.add(os.path.join(SRCDIR, "sstate"), arcname="sstate")
            stream.flush()
    os.rename(tmpfile, get_sstate_archive_path(ctx))

def repodirname(url):
    repourl = urlparse(url)
    return ".".join([seg for seg in [repourl.hostname] + repourl.path.split("/") if seg])

def get_repos(config):
    oecore_url = "git://git.openembedded.org/openembedded-core"
    bitbake_url = "git://git.openembedded.org/bitbake"
    repos = [
        (repodirname(oecore_url), oecore_url, config.get("oecore_ref", "master"), None),
        (repodirname(bitbake_url), bitbake_url, config.get("bitbake_ref", "master"), None)
    ]
    for dep in config["dependencies"]:
        repos.append(
            (repodirname(dep["url"]), dep["url"], dep.get("ref", None), dep.get("layers", None))
        )

    return repos

def update_git_cache(ctx):
    repos = [(repo, repourl) for (repo, repourl, _, _) in get_repos(ctx.config)]
    repos.append((repodirname(ctx.taskdata["gh"]["repository"]["clone_url"]), ctx.taskdata["gh"]["repository"]["clone_url"]))
    for repo, repourl in repos:
        repodir = os.path.join(REPOSDIR, repo)
        if not os.path.isdir(repodir):
            run(ctx, ["git", "clone", "--bare", repourl, repo],
                cwd=REPOSDIR)
        else:
            LOG.info("Fetching %s" % repourl)
            run(ctx, ["git", "fetch"], cwd=repodir)

class GithubAdapter(object):

    def __init__(self, taskdata):
        timestamp = int(time.time())
        payload = {
            "iat": timestamp,
            "exp": timestamp + (10 * 60),
            "iss": taskdata["github_issuer_id"]
        }
        bearer = jwt.encode(payload,
                            key=taskdata["githubapp_pkey"],
                            algorithm="RS256").decode("ascii")
        conn = HTTPSConnection("api.github.com")
        conn.request(
            method="POST",
            url="/installations/{}/access_tokens".format(taskdata["gh"]["installation"]["id"]),
            headers={
                "Authorization": "Bearer {}".format(bearer),
                "Accept": "application/vnd.github.machine-man-preview+json",
                "User-Agent": "nodejs"
            }
        )
        response = conn.getresponse()
        token = json.loads(response.read().decode("ascii"))["token"]
        self.github = Github(login_or_token=token)
        self.repo = self.github.get_repo("%s/%s" % (taskdata["gh"]["repository"]["owner"]["login"],
                                                    taskdata["gh"]["repository"]["name"]))
        self.taskdata = taskdata

    def get_commit(self):
        return self.repo.get_commit(self.taskdata["gh"]["sha"])

    # TODO: !!! VALIDATE INPUT
    def get_config(self):
        if self.taskdata["gh"]["type"] == "pull_request":
            repo = self.github.get_repo("%s/%s" % (self.taskdata["gh"]["pull_request"]["head"]["repo"]["owner"]["login"],
                                                   self.taskdata["gh"]["repository"]["name"]))
        else:
            repo = self.repo
        contentobj = repo.get_file_contents(path=".yottaci.yml",
                                            ref=self.taskdata["gh"]["ref"])
        configs = list(yaml.load_all(contentobj.decoded_content))
        return configs[self.taskdata["config_num"]-1]

def main():
    logging.basicConfig(level=logging.DEBUG)
    with open(TASKDATA) as taskdata_file:
        taskdata = json.loads(taskdata_file.read())
    github = GithubAdapter(taskdata)
    gh_commit = github.get_commit()
    config = github.get_config()
    blob_service = AppendBlobService(account_name=taskdata["storage_account_name"],
                                     account_key=taskdata["storage_account_key"])
    queue_service = QueueService(connection_string=taskdata["queue_connection_string"])
    loop = asyncio.get_event_loop()
    ctx = Context(loop=loop,
                  config=config,
                  blob_service=blob_service,
                  queue_service=queue_service, taskdata=taskdata)

    blob_service.create_container("logs",
                                  fail_on_exist=False,
                                  public_access=PublicAccess.Blob)
    blob_service.create_blob("logs", ctx.pid, content_settings=ContentSettings(content_type="text/plain; charset=utf-8"))
    gh_commit.create_status("pending",
                            target_url=blob_service.make_blob_url("logs", ctx.pid),
                            description="Build started",
                            context=config.get("configuration_name", "configuration%s" % taskdata["config_num"]))
    os.makedirs(REPOSDIR, exist_ok=True)
    # Check if we're the only process who updates the git cache on SMB share.
    # Otherwise skip updating.
    if not os.path.exists(LOCKFILENAME):
        lock = open(LOCKFILENAME, "w")
        lock.close()
        update_git_cache(ctx)
        os.unlink(LOCKFILENAME)

    if os.path.exists(SRCDIR):
        shutil.rmtree(SRCDIR)
    os.makedirs(os.path.join(SRCDIR, "build/conf"))
    with open(os.path.join(SRCDIR, "build/conf/auto.conf"), "a") as localconf:
        localconf.write("\n%s\n" % config.get("localconf", ""))
        localconf.write(AUTOCONFIG)

    repos = get_repos(config)
    repos.append((repodirname(taskdata["gh"]["repository"]["clone_url"]), taskdata["gh"]["repository"]["clone_url"], None, None))
    for reponame, repourl, reporef, _ in repos:
        refrepopath = os.path.join(REPOSDIR, reponame)
        run(ctx, ["git", "clone",
                  "--reference", refrepopath, repourl, reponame],
            cwd=SRCDIR)
        if reporef:
            LOG.info("Checkout %s to %s" % (reponame, reporef))
            run(ctx, ["git", "checkout", "%s" % reporef],
                cwd=os.path.join(SRCDIR, reponame))

    # Do checkout
    if taskdata["gh"]["type"] == "pull_request":
        LOG.info("Add remote repo %s" % taskdata["gh"]["clone_url"])
        run(ctx, ["git", "remote", "add", "contributor",
                  taskdata["gh"]["clone_url"]],
            cwd=os.path.join(SRCDIR, repodirname(taskdata["gh"]["repository"]["clone_url"])))
        LOG.info("Fetch contributor's repo")
        run(ctx, ["git", "fetch", "contributor"], cwd=os.path.join(SRCDIR, repodirname(taskdata["gh"]["repository"]["clone_url"])))
    LOG.info("Checkout %s to %s" % (repodirname(taskdata["gh"]["repository"]["clone_url"]), taskdata["gh"]["sha"]))
    run(ctx, ["git", "checkout", taskdata["gh"]["sha"]],
        cwd=os.path.join(SRCDIR, repodirname(taskdata["gh"]["repository"]["clone_url"])))

    # Fetch sstate if any
    if os.path.exists(get_sstate_archive_path(ctx)):
        with tarfile.open(name=get_sstate_archive_path(ctx), mode="r:gz") as sstate_tar:
            sstate_tar.extractall(path=SRCDIR)

    addlayers = []
    for dep in config["dependencies"]:
        repodir = repodirname(dep["url"])
        layers = dep.get("layers", None)
        if layers:
            addlayers.extend(["bitbake-layers add-layer ../%s/%s" % (repodir, layer)
                              for layer in layers])
        else:
            addlayers.append("bitbake-layers add-layer ../%s" % repodir)
    addlayers.append("bitbake-layers add-layer ../%s" % repodirname(taskdata["gh"]["repository"]["clone_url"]))

    run_script(ctx, BUILDSCRIPT % ("\n".join(addlayers), config["bitbake_target"]), cwd=SRCDIR)
    save_sstate(ctx)

    # Github auth token has expired by now most probably => renew
    github = GithubAdapter(taskdata)
    gh_commit = github.get_commit()
    gh_commit.create_status("success",
                            target_url=blob_service.make_blob_url("logs",
                                                                  ctx.pid),
                            description="Target has been built successfully",
                            context=config.get("configuration_name", "configuration%s" % taskdata["config_num"]))
    loop.close()
    # TODO: copy cloud-init log files to share
    taskdata["build_result"] = "success"
    queue_service.put_message("buildresults", base64.b64encode(json.dumps(taskdata).encode("utf")).decode("utf"))

if __name__ == "__main__":
    main()
