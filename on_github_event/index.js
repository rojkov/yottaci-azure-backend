"use strict";

const querystring = require("querystring");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const moniker = require("moniker");

const common = require("../lib/common");

function base64urlEncode(str) {
  return base64urlEscape(new Buffer(str).toString('base64'));
}

function base64urlEscape(str) {
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function get_github_jwt(iss, pemkey) {
    const signingmethod = "RSA-SHA256";
    const header = {
	"alg": "RS256",
	"typ": "JWT"
    };
    const timestamp = Math.floor((Date.now()/1000));
    const payload = {
	"iat": timestamp,
	"exp": timestamp + (5 * 60),
	"iss": iss
    };

    let segments = [
	base64urlEncode(JSON.stringify(header)),
	base64urlEncode(JSON.stringify(payload))
    ];

    const signature = crypto.createSign(signingmethod).update(segments.join(".")).sign({ key: pemkey }, "base64");

    segments.push(base64urlEscape(signature));

    return segments.join(".");
}

// TODO: make parse_account return an object with all fields instead of tuple
function parse_account(connectionString) {
    let name = null;
    let key = null;

    for (const element of connectionString.split(";")) {
        if (element.startsWith("AccountKey=")) {
            key = element.substring(11);
        } else if (element.startsWith("AccountName=")) {
            name= element.substring(12);
        }
    }

    if (name === null || key === null) {
        throw "Can't parse account: " + connectionString;
    }

    return [name, key];
}

function get_configname(repoconf, counter) {
    let configname = `configuration${counter}`;
    for (const line of repoconf.trim().split("\n")) {
	if (line.startsWith("configuration_name:")) {
	    const [_, value] = line.split(":").map(x => x.trim());
	    configname = value;
	}
    }
    return configname;
}

function *update_github_status(installation_token, github_data, configname) {
    const commitstatus = JSON.stringify({
	"state": "pending",
	"description": "Started processing",
	"context": configname
    });
    yield common.request(
	"POST",
	`https://api.github.com/repos/${github_data.repository.owner.login}/${github_data.repository.name}/statuses/${github_data.sha}`,
	{
	    "Authorization": `token ${installation_token}`,
	    "User-Agent": "nodejs",
	    "Content-Type": "application/json",
	    "Content-Length": Buffer.byteLength(commitstatus)
	},
	commitstatus
    );
}

function *create_resource_group(groupname, subscription_id, token) {
    const groupstr = JSON.stringify({
	location: "northeurope"
    });
    yield common.request(
	"PUT",
	`https://management.azure.com/subscriptions/${subscription_id}/resourcegroups/${groupname}?api-version=2017-05-10`,
	{
	    "Authorization": `Bearer ${token}`,
	    "Content-Type": "application/json",
	    "Content-Length": Buffer.byteLength(groupstr),
	    "User-Agent": "nodejs"
	},
	groupstr
    );
}

function *submit_deployment(groupname, subscription_id, token, deployment_tpl, cloudinit) {
    const deploymentstr = JSON.stringify({
	properties: {
	    parameters: {
                "cloudinit": { "value": cloudinit }
	    },
	    template: deployment_tpl,
	    mode: "Incremental"
	}
    });
    yield common.request(
	"PUT",
	`https://management.azure.com/subscriptions/${subscription_id}/resourcegroups/${groupname}/providers/Microsoft.Resources/deployments/worker-tpl?api-version=2017-05-10`,
	{
	    "Authorization": `Bearer ${token}`,
	    "Content-Type": "application/json",
	    "Content-Length": Buffer.byteLength(deploymentstr),
	    "User-Agent": "nodejs"
	},
	deploymentstr
    );
}

function get_blob(account_name, account_key, container, blobname) {
    return new Promise((resolve, reject) => {
	const headers = common.get_azure_storage_headers(account_name, account_key, `${container}/${blobname}`, "GET", {});
	common.get_http_response(
	    "GET",
	    `https://${account_name}.blob.core.windows.net/${container}/${blobname}`,
	    headers
	).then((response) => {
	    if (response.statusCode == 200) {
		resolve(response.body);
	    } else {
		reject(new Error(`Can't get blob: ${response.statusMessage}\n${response.body}`));
	    }
	}).catch((err) => reject(err));
    });
}

module.exports = function (context, queueitem) {
    const pid = moniker.choose();
    context.log(pid, "Got", queueitem);
    common.run(function*() {
	try {
            const {
                client_id,
                client_secret,
                tenant_id,
                subscription_id,
                gh_pem
            } = common.get_credentials();
	    const deployment_tpl = JSON.parse(fs.readFileSync(path.join(__dirname,
									"worker-template.json"), "utf8"));
	    const cloudinit_tpl = fs.readFileSync(path.join(__dirname, "cloud-init.txt"), "utf8");
            const [data_accname, data_acckey] = parse_account(process.env["YottaCIDataStorage"]);
            const [funcs_accname, funcs_acckey] = parse_account(process.env["WEBSITE_CONTENTAZUREFILECONNECTIONSTRING"]);

	    // Get installation config
	    context.log("Get installation config");
	    const installation_config = JSON.parse(yield get_blob(data_accname, data_acckey, "projects", `github-${queueitem.gh.installation.id}`));
	    if (!installation_config.enabled) {
		context.log("Not enabled. Exiting...");
		context.done();
		return;
	    }

	    // Get ARM token
	    context.log("Get ARM token");
	    const token = yield common.get_azure_token(tenant_id, client_id, client_secret);

	    // Get Github installation token
	    context.log(`Get Github installation token for ${queueitem.gh.installation.id}; Issuer: ` + process.env["GithubIssuerID"] + "; Mode: " + process.env["GithubAppPEM"]);
	    const jwt = get_github_jwt(process.env["GithubIssuerID"], gh_pem);
	    const githubresp = yield common.request(
		"POST",
		`https://api.github.com/installations/${queueitem.gh.installation.id}/access_tokens`,
		{
		    "Authorization": `Bearer ${jwt}`,
		    "Accept": "application/vnd.github.machine-man-preview+json",
		    "User-Agent": "nodejs"
		}
            );
	    const installation_token = JSON.parse(githubresp).token;

	    // Check for presense of config file
	    context.log("Check for .yottaci.yml presence");
	    let repouser = queueitem.gh.repository.owner.login;
	    if (queueitem.gh.type === "pull_request") {
		repouser = queueitem.gh.pull_request.head.repo.owner.login;
	    }
	    const repoconfigstr = Buffer.from(JSON.parse(yield common.request(
		"GET",
		`https://api.github.com/repos/${repouser}/${queueitem.gh.repository.name}/contents/.yottaci.yml?ref=${queueitem.gh.ref}`,
		{
                    "Authorization": `token ${installation_token}`,
                    "User-Agent": "nodejs",
		    "Accept": "application/json",
		}
	    )).content, "base64").toString("ascii");
	    context.log("yottaci config detected. Fire up builds...");

	    let counter = 0;
	    for (let repoconf of repoconfigstr.split(/^---\s*$/m)) {
		repoconf = repoconf.split("\n").filter(x => !x.startsWith("#")).join("\n");
		if (repoconf.trim() === "" && counter === 0) {
		    continue;
		} else if (repoconf.trim() === "") {
		    counter = counter + 1;
		    continue;
		} else {
		    counter = counter + 1;
		}

		// Update GitHub commit status
		const configname = get_configname(repoconf, counter);
		context.log("Update GitHub commit status for " + configname);
		yield *update_github_status(installation_token, queueitem.gh, configname);

		// Create resource group
		const groupname = `${pid}-${counter}`;
		context.log("Create resource group " + groupname + " for subscription " + subscription_id);
		yield *create_resource_group(groupname, subscription_id, token);

		// Submit deployment
		context.log("Submit deployment");
		const taskdata = {
		    "gh": queueitem.gh,
		    "pid": pid,
		    "config_num": counter,
		    "githubapp_pkey": gh_pem,
		    "github_issuer_id": process.env["GithubIssuerID"],
		    "storage_account_name": installation_config.storage_account_name,
		    "storage_account_key": installation_config.storage_account_key,
		    "queue_connection_string": process.env["YottaCIDataStorage"]
		};
		const cloudinit = new Buffer(
                    cloudinit_tpl.replace(
			"%TASKDATA_PLACEHOLDER%", new Buffer(JSON.stringify(taskdata)).toString("base64")
                    ).replace(
			"%STORAGE_USERNAME%", installation_config.storage_account_name
                    ).replace(
			"%STORAGE_NAME%", installation_config.storage_account_name
                    ).replace(
			"%STORAGE_PASSWORD%", installation_config.storage_account_key
                    ).replace(
			"%FUNCSTORAGE_USERNAME%", funcs_accname
                    ).replace(
			"%FUNCSTORAGE_NAME%", funcs_accname
                    ).replace(
			"%FUNCSTORAGE_PASSWORD%", funcs_acckey
                    ).replace(
			"%FUNCSTORAGE_SHARE%", process.env["WEBSITE_CONTENTSHARE"]
                    )
		).toString("base64");
		yield *submit_deployment(groupname, subscription_id, token, deployment_tpl, cloudinit);
	    }
	} catch (err) {
	    context.log.error(err);
	}
	context.log("done");
	context.done();
    });
}
