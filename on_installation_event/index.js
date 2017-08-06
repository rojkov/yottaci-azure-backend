"use strict";

const fs = require("fs");
const path = require("path");

const common = require("../lib/common");

function get_storage_name(context, name, azure_token, subscription_id, counter) {
    var name_to_check;

    return new Promise((resolve, reject) => {
	if (counter > 5) {
	    reject(new Error("Too many tries"));
	} else if (!counter) {
	    counter = 0;
	}

	name_to_check = counter ? `${name}${counter + 1}` : name;
	const reqbody = JSON.stringify({
	    "name": name_to_check,
	    "type": "Microsoft.Storage/storageAccounts"
	});
	context.log(`POST https://management.azure.com/subscriptions/${subscription_id}/providers/Microsoft.Storage/checkNameAvailability?api-version=2016-12-01`);
	common.request(
	    "POST",
	    `https://management.azure.com/subscriptions/${subscription_id}/providers/Microsoft.Storage/checkNameAvailability?api-version=2016-12-01`,
	    {
		"Authorization": `Bearer ${azure_token}`,
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(reqbody),
		"User-Agent": "nodejs"
	    },
	    reqbody
	).then((respbody) => {
	    const result = JSON.parse(respbody);
	    if (result.nameAvailable) {
		resolve(name_to_check);
	    } else {
		resolve(null);
	    }
	}).catch((err) => reject(err));
    }).then((freename) => {
	return freename ? freename : get_storage_name(context, name, azure_token, subscription_id, counter + 1);
    });
}

function create_storage_account(storage_name, groupname, azure_token, subscription_id) {
    return new Promise((resolve, reject) => {
	const reqbody = JSON.stringify({
	    "kind": "Storage",
	    "location": "northeurope",
	    "tags": {},
	    "sku": {
		"name": "Standard_LRS",
		"tier": "Standard"
	    },
	    "properties": {}
	});
	common.get_http_response(
	    "PUT",
	    `https://management.azure.com/subscriptions/${subscription_id}/resourceGroups/${groupname}/providers/Microsoft.Storage/storageAccounts/${storage_name}?api-version=2016-12-01`,
	    {
		"Authorization": `Bearer ${azure_token}`,
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(reqbody),
		"User-Agent": "nodejs"
	    },
	    reqbody
	).then((response) => {
	    if (response.statusCode >= 200 && response.statusCode < 300) {
		resolve(response.body);
	    } else {
		reject(new Error(`Can't create storage account: ${response.statusMessage}\n${response.body}`));
	    }
	}).catch((err) => reject(err));
    });
}

function get_storage_account_props(account_name, groupname, azure_token, subscription_id) {
    return new Promise((resolve, reject) => {
	common.get_http_response(
	    "GET",
	    `https://management.azure.com/subscriptions/${subscription_id}/resourceGroups/${groupname}/providers/Microsoft.Storage/storageAccounts/${account_name}?api-version=2016-12-01`,
	    {
		"Authorization": `Bearer ${azure_token}`,
		"User-Agent": "nodejs"
	    }
	).then(
	    (response) => {
		if (response.statusCode === 200) {
		    resolve(JSON.parse(response.body));
		} else {
		    reject(new Error("Can't get storage account properties: ${response.statusMessage}"));
		}
	    },
	    (err) => reject(err)
	);
    });
}

function get_timer(timeout, value) {
    return new Promise(resolve => {
	setTimeout(_ => resolve(value), timeout);
    });
}

function wait_for_storage_account(account_name, groupname, azure_token, subscription_id, counter) {
    return new Promise((resolve, reject) => {
	if (counter > 15) {
	    reject(new Error("Too many tries"));
	} else if (!counter) {
	    counter = 0;
	}
	get_timer(5000).then(
	    _ => {
		return get_storage_account_props(account_name, groupname, azure_token, subscription_id);
	    }
	).then(
	    (props) => resolve(props.properties.provisioningState),
	    (err) => reject(err)
	)
    }).then(
	state => {
	    if (state === "Succeeded") {
		return "done";
	    } else {
		return wait_for_storage_account(account_name, groupname, azure_token, subscription_id, counter + 1);
	    }
	}
    );
}

function get_storage_account_keys(account_name, groupname, azure_token, subscription_id) {
    return new Promise((resolve, reject) => {
	common.get_http_response(
	    "POST",
	    `https://management.azure.com/subscriptions/${subscription_id}/resourceGroups/${groupname}/providers/Microsoft.Storage/storageAccounts/${account_name}/listKeys?api-version=2016-12-01`,
	    {
		"Authorization": `Bearer ${azure_token}`,
		"User-Agent": "nodejs"
	    }
	).then((response) => {
	    if (response.statusCode >= 200 && response.statusCode < 300) {
		resolve(JSON.parse(response.body));
	    } else {
		reject(new Error(`Can't get keys for storage account: ${response.statusMessage}\n${response.body}`));
	    }
	}).catch((err) => reject(err));
    });
}

function create_file_share(account_name, account_key, share_name) {
    return new Promise((resolve, reject) => {
	common.get_http_response(
	    "PUT",
	    `https://${account_name}.file.core.windows.net/${share_name}?restype=share`,
	    common.get_azure_storage_headers(account_name, account_key, share_name, "PUT", {}, "restype:share")
	).then((response) => {
	    if (response.statusCode == 201) {
		resolve();
	    } else {
		reject(new Error(`Can't create blob container: ${response.statusMessage}\n${response.body}`));
	    }
	}).catch((err) => reject(err));
    });
}

function put_blob(account_name, account_key, container, blobname, blob) {
    return new Promise((resolve, reject) => {
	const headers = common.get_azure_storage_headers(account_name, account_key, `${container}/${blobname}`, "PUT", {
	    "Content-Length": Buffer.byteLength(blob),
	    "x-ms-blob-type": "BlockBlob"
	});
	common.get_http_response(
	    "PUT",
	    `https://${account_name}.blob.core.windows.net/${container}/${blobname}`,
	    headers,
	    blob
	).then((response) => {
	    if (response.statusCode == 201) {
		resolve();
	    } else {
		reject(new Error(`Can't put blob: ${response.statusMessage}\n${response.body}`));
	    }
	}).catch((err) => reject(err));
    });
}

function delete_blob(account_name, account_key, container, blobname) {
    return new Promise((resolve, reject) => {
	const headers = common.get_azure_storage_headers(account_name, account_key, `${container}/${blobname}`, "DELETE", {
	    "x-ms-delete-snapshots": "include"
	});
	common.get_http_response(
	    "DELETE",
	    `https://${account_name}.blob.core.windows.net/${container}/${blobname}`,
	    headers
	).then((response) => {
	    if (response.statusCode == 202) {
		resolve();
	    } else {
		reject(new Error(`Can't delete blob: ${response.statusMessage}\n${response.body}`));
	    }
	}).catch((err) => reject(err));
    });
}

module.exports = function (context, queueitem) {
    const {
        client_id,
        client_secret,
        tenant_id,
        subscription_id,
        gh_pem
    } = common.get_credentials;

    common.run(function*() {
	try {
	    const azure_token = yield common.get_azure_token(tenant_id, client_id, client_secret);
	    const groupname = `github-${queueitem.gh.installation.id}`;
	    const datacreds = common.parse_connection_string(process.env["YottaCIDataStorage"]);

	    if (queueitem.gh.action === "created") {
		yield common.create_resource_group(groupname, azure_token, subscription_id);

		const storage_name = yield get_storage_name(context, `${queueitem.gh.installation.account.login}yottacigh`, azure_token, subscription_id);
		context.log("Chosen storage_name:", storage_name);

		yield create_storage_account(storage_name, groupname, azure_token, subscription_id);
		context.log("storage creation submitted");

		yield wait_for_storage_account(storage_name, groupname, azure_token, subscription_id);
		const acckeys = yield get_storage_account_keys(storage_name, groupname, azure_token, subscription_id);
		const acckey = acckeys.keys[0].value;

		yield create_file_share(storage_name, acckey, "bbcache");
		const config = JSON.stringify({
		    "storage_account_name": storage_name,
		    "storage_account_key": acckey,
		    "enabled": false
		});
		yield put_blob(datacreds.AccountName, datacreds.AccountKey, "projects", groupname, config);
	    } else if (queueitem.gh.action === "deleted") {
		yield delete_blob(datacreds.AccountName, datacreds.AccountKey, "projects", groupname);
		yield common.delete_resource_group(groupname, azure_token, subscription_id);
	    }
	} catch (err) {
	    context.log.error(err);
	}
	context.log("done");
	context.done();
    });
};
