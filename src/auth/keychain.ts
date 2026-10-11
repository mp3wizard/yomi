/**
 * macOS Keychain backing store for Yomi credentials.
 *
 * Vendored from the host app's system/auth keychain service. Used by
 * CredentialStore when running on darwin; other platforms fall back to a
 * plain JSON file (see credential-store.ts).
 */

import { spawn } from 'node:child_process'
import { createCliLogger } from '../util/log.js'

/**
 * Yomi's Keychain service name. Yomi performs a first-party
 * passwordless LINE login (see the `login` MCP tool) and persists the
 * resulting session here — auth token, certificate, refresh token, mid,
 * and the E2EE NaCl keypair. Shared between Yomi MCP and Yomi Desktop.
 */
const SERVICE_NAME = 'dev.rikai.yomi.credentials'
const authLog = createCliLogger('AUTH')

/** Absolute path, so a `security` earlier on PATH cannot intercept the secret. */
const SECURITY_BIN = '/usr/bin/security'

/**
 * `security -i` reads its command lines in 4096-byte chunks and runs any
 * overflow as a separate command, which would store a truncated secret and
 * echo the remainder to stderr. Stay well below that.
 */
const MAX_INTERACTIVE_LINE_BYTES = 4000

/**
 * Quote one argument for the `security -i` command parser: inside double
 * quotes a backslash escapes the next character, nothing else is special.
 *
 * @param value - Raw argument.
 * @returns The quoted argument.
 */
function quoteInteractiveArg(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`
}

/**
 * Build the stdin line for `security -i` that stores a generic password, so
 * the secret never appears in any process argv (which other local users can
 * read with `ps`).
 *
 * @param service - Keychain service name.
 * @param account - Account name.
 * @param password - Secret to store.
 * @returns The command line, or null when it cannot be sent safely (line
 *   breaks or NUL in a value, or too long for `security -i`).
 */
export function buildAddGenericPasswordLine(
  service: string,
  account: string,
  password: string,
): string | null {
  const all = service + account + password
  if (/[\r\n]/.test(all) || all.includes('\0')) {
    return null
  }
  const line = `add-generic-password -U -s ${quoteInteractiveArg(service)} -a ${quoteInteractiveArg(account)} -w ${quoteInteractiveArg(password)}\n`
  return Buffer.byteLength(line) <= MAX_INTERACTIVE_LINE_BYTES ? line : null
}

export interface CredentialResult {
  success: boolean
  account?: string
  password?: string
  error?: string
}

/**
 * Wrapper for macOS `security` keychain CLI commands.
 */
class KeychainCommands {
  constructor(
    private serviceName: string,
    private securityBin: string = SECURITY_BIN,
  ) {}

  /**
   * Store a credential in Keychain.
   *
   * @param account - Account name.
   * @param password - Password to store.
   * @returns Promise resolving to credential result.
   */
  async set(account: string, password: string): Promise<CredentialResult> {
    const line = buildAddGenericPasswordLine(
      this.serviceName,
      account,
      password,
    )
    if (!line) {
      // Never fall back to argv. Remove the older copy instead, so readers
      // that try the Keychain first (the Rust desktop app) do not pick up a
      // stale session; CredentialStore keeps the 0600 file mirror either way.
      await this.delete(account)
      const error = 'Credential too large to store in Keychain without argv'
      authLog.warn('keychain.store.skipped', { account, error })
      return { success: false, account, error }
    }
    return new Promise((resolve) => {
      // No `-A`: the item stays readable only by the creating tool
      // (/usr/bin/security), not by every application without a prompt.
      const child = spawn(this.securityBin, ['-i'])
      child.stdin.on('error', () => {})
      child.stdin.end(line)

      let stderr = ''
      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          authLog.debug('keychain.store.complete', { account })
          resolve({ success: true, account })
        } else {
          authLog.error('keychain.store.failed', {
            account,
            error: stderr || 'Failed to store credential',
          })
          resolve({
            success: false,
            error: stderr || 'Failed to store credential',
          })
        }
      })

      child.on('error', (err) => {
        authLog.error('keychain.store.error', { account, error: err.message })
        resolve({ success: false, error: err.message })
      })
    })
  }

  /**
   * Retrieve a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async get(account: string): Promise<CredentialResult> {
    return new Promise((resolve) => {
      const child = spawn(this.securityBin, [
        'find-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
        '-w',
      ])

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve({
            success: true,
            account,
            password: stdout.trim(),
          })
        } else {
          resolve({
            success: false,
            account,
            error: stderr.includes('could not be found')
              ? 'Credential not found'
              : stderr || 'Failed to retrieve credential',
          })
        }
      })

      child.on('error', (err) => {
        resolve({ success: false, account, error: err.message })
      })
    })
  }

  /**
   * Delete a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async delete(account: string): Promise<CredentialResult> {
    return new Promise((resolve) => {
      const child = spawn(this.securityBin, [
        'delete-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
      ])

      let stderr = ''
      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          authLog.debug('keychain.delete.complete', { account })
          resolve({ success: true, account })
        } else {
          resolve({
            success: false,
            account,
            error: stderr.includes('could not be found')
              ? 'Credential not found'
              : stderr || 'Failed to delete credential',
          })
        }
      })

      child.on('error', (err) => {
        resolve({ success: false, account, error: err.message })
      })
    })
  }
}

/**
 * Service for managing macOS Keychain credentials.
 *
 * Direct reads, writes, and deletes on the canonical Yomi namespace.
 */
export class KeychainService {
  private commands: KeychainCommands

  /**
   * @param securityBin - Path to the `security` tool; tests pass a stand-in.
   */
  constructor(securityBin: string = SECURITY_BIN) {
    this.commands = new KeychainCommands(SERVICE_NAME, securityBin)
  }

  /**
   * Stores a credential in Keychain.
   *
   * @param account - Account name.
   * @param password - Password to store.
   * @returns Promise resolving to credential result.
   */
  async setCredential(
    account: string,
    password: string,
  ): Promise<CredentialResult> {
    return await this.commands.set(account, password)
  }

  /**
   * Retrieves a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async getCredential(account: string): Promise<CredentialResult> {
    return await this.commands.get(account)
  }

  /**
   * Deletes a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async deleteCredential(account: string): Promise<CredentialResult> {
    return await this.commands.delete(account)
  }
}

let keychainServiceInstance: KeychainService | null = null

/**
 * Gets the singleton keychain service instance.
 *
 * @returns The KeychainService instance.
 */
export function getKeychainService(): KeychainService {
  if (!keychainServiceInstance) {
    keychainServiceInstance = new KeychainService()
  }
  return keychainServiceInstance
}
