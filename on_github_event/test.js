"use strict";

const mut = require("./index");

const fs = require("fs");
const path = require("path");

const logger = console.log;
logger.error = function(msg) {
    console.log("ERROR:", msg);
}

const context = {
    log: console.log,
    done: function() {}
};

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

const testcreds = JSON.parse(fs.readFileSync(path.join(__dirname, "../testcreds.json"), "utf8"));

process.env["YottaCIDataStorage"] = testcreds.YottaCIDataStorage
process.env["WEBSITE_CONTENTAZUREFILECONNECTIONSTRING"] = testcreds.WEBSITE_CONTENTAZUREFILECONNECTIONSTRING;
process.env["WEBSITE_CONTENTSHARE"] = testcreds.WEBSITE_CONTENTSHARE;
process.env["GithubIssuerID"] = testcreds.GithubIssuerID;

mut(context, queueItem);
