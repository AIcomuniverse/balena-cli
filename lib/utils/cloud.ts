/**
 * @license
 * Copyright 2019 Balena Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type * as SDK from 'balena-sdk';
import * as _ from 'lodash';
import { getBalenaSdk, getCliForm, getVisuals, stripIndent } from './lazy';

import { ExpectedError } from '../errors';

export const serviceIdToName = _.memoize(
	async (
		sdk: SDK.BalenaSDK,
		serviceId: number,
	): Promise<string | undefined> => {
		const serviceName = await sdk.pine.get<SDK.Service>({
			resource: 'service',
			id: serviceId,
			options: {
				$select: 'service_name',
			},
		});

		if (serviceName != null) {
			return serviceName.service_name;
		}
		return;
	},
	// Memoize the call based on service id
	(_sdk, id) => id.toString(),
);

/**
 * Return Device and Application objects for the given device UUID (short UUID
 * or full UUID). An error is thrown if the application is not accessible, e.g.
 * if the application owner removed the current user as a collaborator (but the
 * device still belongs to the current user).
 */
export const getDeviceAndAppFromUUID = _.memoize(
	async (
		sdk: SDK.BalenaSDK,
		deviceUUID: string,
		selectDeviceFields?: Array<keyof SDK.Device>,
		selectAppFields?: Array<keyof SDK.Application>,
	): Promise<[SDK.Device, SDK.Application]> => {
		const [device, app] = await getDeviceAndMaybeAppFromUUID(
			sdk,
			deviceUUID,
			selectDeviceFields,
			selectAppFields,
		);
		if (app == null) {
			throw new ExpectedError(stripIndent`
				Unable to access the fleet that device ${deviceUUID} belongs to.
				Hint: check whether the fleet owner withdrew access to it.
			`);
		}
		return [device, app];
	},
	// Memoize the call based on UUID
	(_sdk, deviceUUID) => deviceUUID,
);

/**
 * Return a Device object and maybe an Application object for the given device
 * UUID (short UUID or full UUID). The Application object may be undefined if
 * the user / device lost access to the application, e.g. if the application
 * owner removed the user as a collaborator (but the device still belongs to
 * the current user).
 */
export const getDeviceAndMaybeAppFromUUID = _.memoize(
	async (
		sdk: SDK.BalenaSDK,
		deviceUUID: string,
		selectDeviceFields?: Array<keyof SDK.Device>,
		selectAppFields?: Array<keyof SDK.Application>,
	): Promise<[SDK.Device, SDK.Application | undefined]> => {
		const pineOpts = {
			$expand: selectAppFields
				? { belongs_to__application: { $select: selectAppFields } }
				: 'belongs_to__application',
		} as SDK.PineOptions<SDK.Device>;
		if (selectDeviceFields) {
			pineOpts.$select = selectDeviceFields as any;
		}
		const device = await sdk.models.device.get(deviceUUID, pineOpts);
		const apps = device.belongs_to__application as SDK.Application[];
		if (_.isEmpty(apps) || _.isEmpty(apps[0])) {
			return [device, undefined];
		}
		return [device, apps[0]];
	},
	// Memoize the call based on UUID
	(_sdk, deviceUUID) => deviceUUID,
);

/**
 * Download balenaOS image for the specified `deviceType`.
 * `OSVersion` may be one of:
 *  - exact version number,
 *  - valid semver range,
 *  - `latest` (includes pre-releases),
 *  - `default` (excludes pre-releases if at  least one stable version is available),
 *  - `recommended` (excludes pre-releases, will fail if only pre-release versions are available),
 *  - `menu` (will show the interactive menu )
 * If not provided, OSVersion will be set to `default`
 *
 * @param deviceType
 * @param outputPath
 * @param OSVersion
 */
export async function downloadOSImage(
	deviceType: string,
	outputPath: string,
	OSVersion?: string,
) {
	console.info(`Getting device operating system for ${deviceType}`);

	if (!OSVersion) {
		console.warn('OS version not specified: using latest released version');
	}

	OSVersion = OSVersion
		? await resolveOSVersion(deviceType, OSVersion)
		: 'default';

	// Override the default zlib flush value as we've seen cases of
	// incomplete files being identified as successful downloads when using Z_SYNC_FLUSH.
	// Using Z_NO_FLUSH results in a Z_BUF_ERROR instead of a corrupt image file.
	// https://github.com/nodejs/node/blob/master/doc/api/zlib.md#zlib-constants
	// Hopefully this is a temporary workaround until we can resolve
	// some ongoing issues with the os download stream.
	process.env.ZLIB_FLUSH = 'Z_NO_FLUSH';

	const manager = await import('balena-image-manager');
	const stream = await manager.get(deviceType, OSVersion);

	const displayVersion = await new Promise((resolve, reject) => {
		stream.on('error', reject);
		stream.on('balena-image-manager:resolved-version', resolve);
	});

	const visuals = getVisuals();
	const bar = new visuals.Progress(
		`Downloading balenaOS version ${displayVersion}`,
	);
	const spinner = new visuals.Spinner(
		`Downloading balenaOS version ${displayVersion} (size unknown)`,
	);

	stream.on('progress', (state: any) => {
		if (state != null) {
			return bar.update(state);
		} else {
			return spinner.start();
		}
	});

	stream.on('end', () => {
		spinner.stop();
	});

	// We completely rely on the `mime` custom property
	// to make this decision.
	// The actual stream should be checked instead.
	let output;
	if (stream.mime === 'application/zip') {
		const unzip = await import('node-unzip-2');
		output = unzip.Extract({ path: outputPath });
	} else {
		const fs = await import('fs');
		output = fs.createWriteStream(outputPath);
	}

	const streamToPromise = await import('stream-to-promise');
	await streamToPromise(stream.pipe(output));

	console.info(
		`balenaOS image version ${displayVersion} downloaded successfully`,
	);

	return outputPath;
}

async function resolveOSVersion(
	deviceType: string,
	version: string,
): Promise<string> {
	if (['menu', 'menu-esr'].includes(version)) {
		return await selectOSVersionFromMenu(deviceType, version === 'menu-esr');
	}
	if (version[0] === 'v') {
		version = version.slice(1);
	}
	// The version must end with either '.dev' or '.prod', as expected
	// by `balena-image-manager` and the balena SDK. Note that something
	// like '2.88.4.prod' is not valid semver (https://semver.org/),
	// so we don't even attempt semver parsing here.
	if (!version.endsWith('.dev') && !version.endsWith('.prod')) {
		version += '.prod';
	}
	return version;
}

async function selectOSVersionFromMenu(
	deviceType: string,
	esr: boolean,
): Promise<string> {
	const vs = await getFormattedOsVersions(deviceType, esr);

	const choices = vs.map((v) => ({
		value: v.rawVersion,
		name: v.formattedVersion,
	}));

	return getCliForm().ask({
		message: 'Select the OS version:',
		type: 'list',
		choices,
		default: (vs.find((v) => v.isRecommended) ?? vs[0])?.rawVersion,
	});
}

/**
 * Return the output of sdk.models.hostapp.getAvailableOsVersions(), filtered
 * regarding ESR or non-ESR versions, and having the `formattedVersion` field
 * reformatted for compatibility with the pre-existing output format of the
 * `os versions` and `os download` commands.
 */
export async function getFormattedOsVersions(
	deviceType: string,
	esr: boolean,
): Promise<SDK.OsVersion[]> {
	const versions: SDK.OsVersion[] = (
		(await getBalenaSdk().models.hostapp.getAvailableOsVersions([deviceType]))[
			deviceType
		] ?? []
	)
		.filter((v: SDK.OsVersion) => v.osType === (esr ? 'esr' : 'default'))
		.map((v: SDK.OsVersion) => {
			const i = v.formattedVersion.indexOf(' ');
			v.formattedVersion =
				i < 0
					? `v${v.rawVersion}`
					: `v${v.rawVersion}${v.formattedVersion.substring(i)}`;
			return v;
		});
	if (!versions.length) {
		throw new ExpectedError(stripIndent`
			Error: No balenaOS versions found for device type '${deviceType}'.
			Double-check the device type slug with 'balena devices supported'.`);
	}
	return versions;
}
