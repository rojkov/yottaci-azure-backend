"use strict";

const querystring = require("querystring");
const fs = require("fs");
const path = require("path");

const common = require("../lib/common");

module.exports = function (context, queueitem) {
    common.run(function*() {
	try {
            const {
                client_id,
                client_secret,
                tenant_id,
                subscription_id,
                gh_pem
            } = common.get_credentials();

	    // Get ARM token
	    const postdata = querystring.stringify({
		"grant_type": "client_credentials",
		"client_id": client_id,
		"client_secret": client_secret,
		"resource": "https://management.azure.com/"
	    })
	    const content = yield common.request(
		"POST",
		`https://login.microsoftonline.com/${tenant_id}/oauth2/token`,
		{
		    "Content-Type": "application/x-www-form-urlencoded",
		    "Content-Length": Buffer.byteLength(postdata),
		    "User-Agent": "nodejs"
		},
		postdata
	    );
	    const token = JSON.parse(content).access_token;

	    // Delete resource group
	    const group = `${queueitem.pid}-${queueitem.config_num}`;
	    yield common.request(
		"DELETE",
		`https://management.azure.com/subscriptions/${subscription_id}/resourcegroups/${group}?api-version=2017-05-10`,
		{
		    "Authorization": `Bearer ${token}`,
		    "User-Agent": "nodejs"
		}
	    );
	} catch (err) {
	    context.log.error(err);
	}
	context.log("done");
	context.done();
    });
}
