"use strict";

const fs = require("fs");
const path = require("path");

const mut = require("./index");

const logger = console.log;
logger.error = function(msg) {
    console.log("ERROR:", msg);
}

const context = {
    log: console.log,
    done: function() {}
};
context.log.error = function(msg) {
    console.log("ERROR:", msg);
}

const queueitem = {
    gh: {
	action: "created", // alternatively this can be "deleted" ("created")
	installation: {
	    id: 45674,
	    account: {
		login: "rojkov5"
	    }
	}
    }
};

const testcreds = JSON.parse(fs.readFileSync(path.join(__dirname, "../testcreds.json"), "utf8"));

process.env["YottaCIDataStorage"] = testcreds.YottaCIDataStorage

mut(context, queueitem);
