import 'core-js/actual/typed-array/from-base64'
import 'core-js/actual/typed-array/to-base64'
import 'core-js/actual/typed-array/from-hex'
import 'core-js/actual/typed-array/to-hex'
import 'core-js/actual/array/from-async'
import { MemoryCache, OpenPGPCryptoWithCryptoProxy, ProtonDriveClient, type ProtonDriveHTTPClientJsonRequest } from '@protontech/drive-sdk'
import { CryptoProxy } from '@protontech/crypto'
import { Api } from '@protontech/crypto/proxy/endpoint/api.ts'
import { computeKeyPassword, generateKeySalt, getSrp } from '@protontech/crypto/srp'
import { version } from '../../../package.json'

Api.init({})
CryptoProxy.setEndpoint(new Api())

export function createProtonDriveClient(signal?: AbortSignal) {
    const anonymousOnly = async (): Promise<never> => { throw new Error('This client only supports public links') }
    const request = async (req: ProtonDriveHTTPClientJsonRequest): Promise<Response> => {
        const headers = new Headers(req.headers)
        headers.set('x-pm-appversion', `external-drive-risubard@${version}-alpha`)
        if (req.json) headers.set('content-type', 'application/json')
        const signals = [signal, req.signal, AbortSignal.timeout(req.timeoutMs)].filter((s): s is AbortSignal => !!s)
        return fetch(req.url, {
            method: req.method, headers, credentials: 'omit',
            body: req.json ? JSON.stringify(req.json) : req.body,
            signal: AbortSignal.any(signals),
        })
    }
    return new ProtonDriveClient({
        httpClient: { fetchJson: request, fetchBlob: request },
        entitiesCache: new MemoryCache(), cryptoCache: new MemoryCache(),
        account: {
            getOwnPrimaryAddress: anonymousOnly, getOwnAddress: anonymousOnly,
            getOwnAddresses: async () => [], hasProtonAccount: async () => false,
            getPublicKeys: async () => [],
        },
        openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
        srpModule: {
            getSrp: (Version, Modulus, ServerEphemeral, Salt, password) =>
                getSrp({ Version, Modulus, ServerEphemeral, Salt }, { password }),
            computeKeyPassword, generateKeySalt, getSrpVerifier: anonymousOnly,
        },
    })
}
