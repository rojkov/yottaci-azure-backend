const assert = require("assert");
const sinon = require("sinon");
const on_github_event = require("../index");

let common = require("../../lib/common");

const queueItem = {
    gh: {
	ref: "bbcibot-patch-1",
	sha: "8b14c28758903d854933199dc827ef5f92f95afb",
	type: "pull_request",
	clone_url: "https://github.com/bbcibot/meta-ros.git",
        pull_request: {
            head: {
                repo: {
	            clone_url: "https://github.com/bbcibot/meta-ros.git",
                    owner: { login: "bbcibot" }
                }
            }
        },
	repository: {
	    name: "meta-ros",
	    owner: {
		login: "rojkov"
	    },
	    clone_url: "https://github.com/rojkov/meta-ros.git",
	},
	installation: {
	    id: 45679
	}
    }
};

describe("on_github_event handler", function() {

    let ctx = {
	log: console.log,
	done: function() {}
    };
    ctx.log.error = function(err) { console.log("ERROR:", err); };

    beforeEach(function() {
	sinon.spy(ctx.log, "error");

	process.env["YottaCIDataStorage"] = "AccountName=test;AccountKey=test";
	process.env["WEBSITE_CONTENTAZUREFILECONNECTIONSTRING"] = "AccountName=test;AccountKey=test";
	process.env["WEBSITE_CONTENTSHARE"] = "AccountName=test;AccountKey=test";
	process.env["GithubIssuerID"] = "AccountName=test;AccountKey=test";
    });

    afterEach(function() {
	common.request.restore();
	ctx.log.error.restore();
    });

    describe("testing failure cases", function() {

	afterEach(function() {
	    assert(ctx.log.error.calledOnce);
	});

	it("should fail since there's no .yottaci.yml", function(done) {
	    ctx.done = done;

	    let fakereq = sinon.stub(common, "request");
	    fakereq.onCall(0).resolves(JSON.stringify({access_token: "fake_access_token"}));
	    fakereq.onCall(1).resolves(JSON.stringify({token: "fake_token"}));
	    fakereq.onCall(2).rejects(new Error("THERE IS NO FILE"));

	    on_github_event(ctx, queueItem);
	});
    });

    describe("testing successfull cases", function() {
	var fakereq;

	afterEach(function() {
	    assert(ctx.log.error.notCalled);
	});

	it("should not submit a deployment for empty config", function(done) {
	    ctx.done = done;

	    fakereq = sinon.stub(common, "request");
	    fakereq.onCall(0).resolves(JSON.stringify({access_token: "fake_access_token"}));
	    fakereq.onCall(1).resolves(JSON.stringify({token: "fake_token"}));
	    fakereq.onCall(2).resolves(JSON.stringify({content: new Buffer("#Fake config\n---\n").toString("base64")}));

	    on_github_event(ctx, queueItem);
	});

	it("should submit one deployment", function(done) {
	    ctx.done = done;

	    fakereq = sinon.stub(common, "request");
	    fakereq.onCall(0).resolves(JSON.stringify({access_token: "fake_access_token"}));
	    fakereq.onCall(1).resolves(JSON.stringify({token: "fake_token"}));
	    fakereq.onCall(2).resolves(JSON.stringify({content: new Buffer("#Fake config\n---\nconfiguration_name: test\n").toString("base64")}));

	    on_github_event(ctx, queueItem);
	});
    });
});
