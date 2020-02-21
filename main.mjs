import DnsProvider from '../../dns-provider.mjs';
import AppCsl from '../../utils/app-csl.mjs'
import HttpRequest from '../../utils/http-request.mjs';

//#region **** Errors ****
class GoDaddyInvalidSchema extends Error {
	constructor(req) {
		const body = req.json;
		let message = `${body.code}: ${body.message}\n`;
		for (let f of body.fields) {
			message += `- ${f.path}: ${f.code}: ${f.message}\n`;
		}

		super(message);
	}
}
//#endregion

export default class Bluehost extends DnsProvider {
	static csl = new AppCsl('bluehost');

	static _BASE_URL = 'https://my.bluehost.com';

	static _UID_TAG = '[UID]';
	static _DOMAIN_TAG = '[DOMAIN]'

	static _LOGIN_URL = `${Bluehost._BASE_URL}/web-hosting/cplogin`;
	static _LOGIN_METHOD = HttpRequest.verbs.POST
	static _UID_URL = `${Bluehost._BASE_URL}/api/users`;
	static _UID_METHOD = HttpRequest.verbs.GET

	static _GET_URL = `${Bluehost._BASE_URL}/api/users/${Bluehost._UID_TAG}/domains/${Bluehost._DOMAIN_TAG}/features/dns`
	static _GET_METHOD = HttpRequest.verbs.GET;

	static _ADD_URL = `${Bluehost._BASE_URL}/api/users/${Bluehost._UID_TAG}/domains/${Bluehost._DOMAIN_TAG}/features/dns`
	static _ADD_METHOD = HttpRequest.verbs.POST

	static _UPDATE_URL = `${Bluehost._BASE_URL}/api/users/${Bluehost._UID_TAG}/domains/${Bluehost._DOMAIN_TAG}/features/dns`
	static _UPDATE_METHOD = HttpRequest.verbs.PUT

	/**
	 * Get the dns provider definition.
	 * @returns {PluginDef} The dns provider definition.
	 */
	static get definition() {
		return Object.assign(super.definition, {
			name: 'Bluehost',
			version: '1.0.0',
			description: `This plugin uses the <a href="https://bluehost.com" target="_blank">Bluehost</a>'s private Web API to update DNS records hosted in Bluehost's zones.`,
			record: [{
				print: 'Main domain',
				name: 'user',
				type: 'text',
				required: true
			}, {
				print: 'Password',
				name: 'pass',
				type: 'password',
				required: true
			}],
			configurator: [{
				name: "more",
				page: "/root/dns-provider/bluehost/about.html"
			}]
		});
	}

	/**
	 * Update the specified DNS Entry
	 * @param {DnsEntry} record The record to be updated.
	 * @returns {Promise<void>} Return a promise resolving once the record is updated, otherwise will reject with the error.
	 */
	static async update(record, ip) {
		Bluehost.csl.info(`Updating ${record.record}`);

		const match = Bluehost._matchRecord(record);
		const domain = match[2];
		const basePayload = {
			name: match[1] || '@',
			content: ip[record.type],
			ttl: record.ttl,
			type: Bluehost._getRecordType(record)
		}
		
		try {
			// Login
			const login = await Bluehost._login(record);
			Bluehost.csl.verb(`Logged in as ${record.user} (${login.uid}) Session: ${login.session}`);
			
			// Find old record.
			const old = await Bluehost._getRecord(login, domain, basePayload);

			// Add/Update
			if (old) {
				// Update
				Bluehost.csl.verb(`Entry ${old.name} (${old.type}) found`);
				this._updateRecord(login, domain, old, basePayload);
			} else {
				// Add
				Bluehost.csl.verb(`Entry ${basePayload.name} (${basePayload.type}) not found`);
				this._addRecord(login, domain, basePayload);
			}
		}
		catch(ex) { Bluehost.csl.err(ex); }
	}

	/**
	 * Login with the credentials.
	 * @param {DnsEntry} record The dns record.
	 * @returns {BluehostLogin} The login info.
	 */
	static async _login(record) {
		/** @type {BluehostLogin} */
		let login = {};

		// Get USESSION.
		let req = new HttpRequest(Bluehost._LOGIN_METHOD, Bluehost._LOGIN_URL);
		req.formEncoded = {
			ldomain: record.user,
			lpass: record.pass
		};
		await req.execute();
		if (req.response.statusCode !== 302) {
			if (req.response.statusCode === 200)
				throw new Error(`${req.response.statusCode}: Login failed, please verify login credentials for the record.`);
			else
				throw new Error(`${req.response.statusCode}: Server did not respond properly.`)
		}
		const cookie = req.response.headers['set-cookie'].find(x => x.includes('usession'));
		const usessionMatch = /^usession=([^;]*);/.exec(cookie)
		if (usessionMatch) {
			login.session = usessionMatch[1];
		} else {
			throw new Error('Login session not found.');
		}

		// Get UID.
		req = new HttpRequest(Bluehost._UID_METHOD, Bluehost._UID_URL);
		req.cookies = { usession: login.session };
		await req.execute();
		if (req.response.statusCode === 200)
			login.uid = req.json.user_id;
		else
			throw new Error('Unable to get user ID.');

		return login;
	}

	/**
	 * Get the current DNS zone entries.
	 * @param {BluehostLogin} login The login detail.
	 * @param {string} domain The domain.
	 * @param {BlueHostZoneEntry} newData The new record.
	 * @returns {BlueHostZoneEntry} The old entry.
	 */
	static async _getRecord(login, domain, newData) {
		const url = Bluehost._GET_URL
			.replace(Bluehost._UID_TAG, login.uid)
			.replace(Bluehost._DOMAIN_TAG, domain);
		const req = new HttpRequest(Bluehost._GET_METHOD, url);
		req.cookies = { usession: login.session }

		await req.execute();
		if (req.response.statusCode === 200) {
			const data = req.json;
			return (data.records[newData.type] || []).find(x => x && (x.name === newData.name))
		} else
			throw new Error('Unable to get current zone records.');
	}

	/**
	 * Insert a new record in the zone.
	 * @param {BluehostLogin} login The login detail.
	 * @param {string} domain The domain.
	 * @param {BlueHostZoneEntry} newData The new record.
	 * @returns {undefined}
	 */
	static async _addRecord(login, domain, newData) {
		const url = Bluehost._ADD_URL
			.replace(Bluehost._UID_TAG, login.uid)
			.replace(Bluehost._DOMAIN_TAG, domain);
		const req = new HttpRequest(Bluehost._ADD_METHOD, url);
		req.cookies = { usession: login.session }
		req.json = {
			domain: domain,
			record: newData
		}

		await req.execute();
		if (req.response.statusCode === 204) {
			Bluehost.csl.info(`Record ${newData.name} for ${domain} pointing to ${newData.content} inserted.`);
		} else
			throw new Error('Failed to insert record properly.');
	}

	/**
	 * Update a zone record
	 * @param {BluehostLogin} login The login detail.
	 * @param {string} domain The domain.
	 * @param {BlueHostZoneEntry} newData The new record.
	 * @returns {undefined}
	 */
	static async _updateRecord(login, domain, oldData, newData) {
		const url = Bluehost._UPDATE_URL
			.replace(Bluehost._UID_TAG, login.uid)
			.replace(Bluehost._DOMAIN_TAG, domain);
		const req = new HttpRequest(Bluehost._UPDATE_METHOD, url);
		req.cookies = { usession: login.session }
		req.json = {
			domain: domain,
			old: oldData,
			new: newData
		}

		await req.execute();
		if (req.response.statusCode === 204) {
			Bluehost.csl.info(`Record ${newData.name} for ${domain} pointing to ${newData.content} updated.`);
		} else
			throw new Error('Failed to update record properly.');
	}
}

/**
 * Login information.
 * @typedef {Object} BluehostLogin
 * @property {string} session The session token.
 * @property {string} uid The user identifier.
 */

/**
 * A Bluehost Zone entry.
 * @typedef {Object} BlueHostZoneEntry
 * @property {string} content The entry destination.
 * @property {string} name The subdomain.
 * @property {string} ttl The entry Time-to-Live.
 * @property {string} type Type of entry.
 */