"use strict";

const mut = require("./index");

const logger = console.log;
logger.error = function(msg) {
    console.log("ERROR:", msg);
}

const context = {
    log: console.log,
    done: function() {}
};

const queueitem = {
    pid: "bla-bla"
    config_num: 1
};

mut(context, queueitem);
