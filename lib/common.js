const urllib = require("url");
const querystring = require("querystring");
const crypto = require("crypto");

function run(taskDef) {

    // create the iterator
    let task = taskDef();

    // start the task
    let result = task.next();

    // recursive function to iterate through
    (function step() {

        // if there's more to do
        if (!result.done) {

            // resolve to a promise to make it easy
            let promise = Promise.resolve(result.value);
            promise.then(function(value) {
                result = task.next(value);
                step();
            }).catch(function(error) {
                result = task.throw(error);
                step();
            });
        }
    }());
}

function request(method, url, headers, postdata) {
    return new Promise((resolve, reject) => {
	// select http or https module, depending on reqested url
	const {protocol, hostname, path, query} = urllib.parse(url);
	const [lib, port]= protocol === "https:" ? [require('https'), 443] : [require('http'), 80];
	const options = {
	    "hostname": hostname,
	    "port": port,
	    "path": path,
	    "method": method,
	    "headers": headers ? headers : {}
	};
	const req = lib.request(options, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
                request(method, response.headers.location, headers, postdata).then((body) => resolve(body), (err) => reject(err));
                return;
            } else if (response.statusCode < 200 || response.statusCode > 299) {
		reject(new Error('Failed to load page, status code: ' + response.statusCode + ' ' + response.statusMessage));
	    }

	    const body = [];
	    response.on('data', (chunk) => body.push(chunk));
	    response.on('end', () => resolve(body.join('')));
	});
	req.on('error', (err) => reject(err));

	if ((method === "POST" || method === "PUT") && postdata) {
	    req.write(postdata);
	}
	req.end();
    });
}

function get_http_response(method, url, headers, postdata) {
    return new Promise((resolve, reject) => {
	// select http or https module, depending on reqested url
	const {protocol, hostname, path, query} = urllib.parse(url);
	const [lib, port]= protocol === "https:" ? [require('https'), 443] : [require('http'), 80];
	const options = {
	    "hostname": hostname,
	    "port": port,
	    "path": path,
	    "method": method,
	    "headers": headers ? headers : {}
	};
	const req = lib.request(options, (response) => {
	    const body = [];
	    response.on('data', (chunk) => body.push(chunk));
	    response.on('end', () => {
		const respobj = {
		    body: body.join(''),
		    statusCode: response.statusCode,
		    statusMessage: response.statusMessage,
		    headers: response.headers
		};
		resolve(respobj);
	    });
	});
	req.on('error', (err) => reject(err));

	if ((method === "POST" || method === "PUT") && postdata) {
	    req.write(postdata);
	}
	req.end();
    }).then((respobj) => {
	if (respobj.statusCode === 301 || respobj.statusCode === 302 || respobj.statusCode === 307) {
	    return get_http_response(method, respobj.headers.location, headers, postdata);
	} else {
	    return respobj;
	}
    });
}

function get_azure_token(tenant_id, client_id, client_secret) {
    return new Promise((resolve, reject) => {
	const postdata = querystring.stringify({
	    "grant_type": "client_credentials",
	    "client_id": client_id,
	    "client_secret": client_secret,
	    "resource": "https://management.azure.com/"
	});
	request(
	    "POST",
	    `https://login.microsoftonline.com/${tenant_id}/oauth2/token`,
	    {
		"Content-Type": "application/x-www-form-urlencoded",
		"Content-Length": Buffer.byteLength(postdata),
		"User-Agent": "nodejs"
	    },
	    postdata
	).then(
	    (respcontent) => {
		resolve(JSON.parse(respcontent).access_token);
	    },
	    (err) => reject(err)
	);
    });
}

function create_resource_group(groupname, token, subscription_id) {
    return new Promise((resolve, reject) => {
	const groupstr = JSON.stringify({
	    location: "northeurope"
	});
	request(
	    "PUT",
	    `https://management.azure.com/subscriptions/${subscription_id}/resourcegroups/${groupname}?api-version=2017-05-10`,
	    {
		"Authorization": `Bearer ${token}`,
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(groupstr),
		"User-Agent": "nodejs"
	    },
	    groupstr
	).then(
	    (_) => resolve(),
	    (err) => reject(err)
	);
    });
}

function delete_resource_group(groupname, token, subscription_id) {
    return new Promise((resolve, reject) => {
	get_http_response(
	    "DELETE",
	    `https://management.azure.com/subscriptions/${subscription_id}/resourcegroups/${groupname}?api-version=2017-05-10`,
	    {
		"Authorization": `Bearer ${token}`,
		"User-Agent": "nodejs"
	    }
	).then(
	    (response) => {
		if (response.statusCode === 200 || response.statusCode === 202) {
		    resolve();
		} else {
		    reject(new Error(`Can't delete resource group: ${response.statusMessage}`));
		}
	    },
	    (err) => reject(err)
	);
    });
}

// TODO: this is ugly
function get_azure_storage_headers(accountname, accountkey, resource, method, headers, canonicalized_params) {
    const msdate = (new Date).toUTCString();
    const params = canonicalized_params ? `\n${canonicalized_params}` : "";
    const inputvalue = method + "\n" + /*VERB*/
	  (headers["Content-Encoding"] ? headers["Content-Encoding"] : "") + "\n" +
	  (headers["Content-Language"] ? headers["Content-Language"] : "") + "\n" +
	  (headers["Content-Length"] ? headers["Content-Length"] : "") + "\n" +
	  (headers["Content-MD5"] ? headers["Content-MD5"] : "") + "\n" +
	  (headers["Content-Type"] ? headers["Content-Type"] : "") + "\n" +
	  "\n" + /*Date*/
	  "\n" + /*If-Modified-Since*/
	  "\n" + /*If-Match*/
	  "\n" + /*If-None-Match*/
	  "\n" + /*If-Unmodified-Since*/
	  "\n" + /*Range*/
	  (headers["x-ms-blob-type"] ? `x-ms-blob-type:${headers["x-ms-blob-type"]}\n` : "") +
	  `x-ms-date:${msdate}\n` +
	  (headers["x-ms-delete-snapshots"] ? `x-ms-delete-snapshots:${headers["x-ms-delete-snapshots"]}\n` : "") +
	  "x-ms-version:2017-04-17\n" +
	  `/${accountname}/${resource}${params}`;

    const key = new Buffer(accountkey, "base64");
    let hmac = crypto.createHmac("sha256", key);
    hmac.update(inputvalue);
    const signature = hmac.digest("base64");

    let result = headers;
    result["User-Agent"] = "nodejs";
    result["x-ms-version"] = "2017-04-17";
    result["x-ms-date"] = msdate;
    result["Authorization"] = `SharedKey ${accountname}:${signature}`;
    return result;
}

function parse_connection_string(connection_string) {
    let creds = {};
    for (const element of connection_string.split(";")) {
	const [key, value] = element.split("=");
	creds[key] = value;
    }
    return creds;
}

function get_credentials() {
    return {
	client_id: process.env["YottaCIClientID"],
	client_secret: process.env["YottaCIClientSecret"],
	tenant_id: process.env["YottaCITenantID"],
	subscription_id: process.env["YottaCISubscriptionID"],
	gh_pem: process.env["GHPEM"]
    };
}

module.exports = {
    run: run,
    request: request,
    get_azure_token: get_azure_token,
    create_resource_group: create_resource_group,
    delete_resource_group: delete_resource_group,
    get_http_response: get_http_response,
    get_azure_storage_headers: get_azure_storage_headers,
    parse_connection_string: parse_connection_string,
    get_credentials: get_credentials
};
