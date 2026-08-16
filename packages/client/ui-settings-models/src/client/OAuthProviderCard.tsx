/** OAuth-specific provider card with page-local device-code instructions. */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsSectionInjected, ProviderIdentity } from './ModelsSection.tsx'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import styles from './ModelsSection.module.css'

interface DeviceCodeView {
  verificationUri: string
  userCode: string
  intervalSeconds?: number
}

type PendingAction = 'start' | 'cancel' | 'disconnect'

interface ActiveStart {
  generation: number
  entry: ProviderRow['entry']
  profileCreationPending: boolean
}

// The browser has no forwarded OAuth lifecycle event: status is deliberately
// loopback-only. Refresh while device-code login is live so a remote expiry or
// cancellation cannot leave the card at Connecting forever.
const OAUTH_STATUS_REFRESH_DELAY_MS = 1_000

/** Props for one OAuth provider route. */
export interface OAuthProviderCardProps {
  /** Joined provider row carrying the redacted connection state. */
  row: ProviderRow
  /** Page controller used to reload the authoritative redacted snapshot. */
  controller: ModelsSettingsStore
  /** OAuth and settings wire operations. */
  api: Pick<IApiClient, 'settings' | 'llm'>
  /** Models section copy. */
  t: ModelsSectionInjected['t']
  /** Whether deployment settings accept writes. */
  readOnly: boolean
  /** Accessible label for the optional remove action. */
  removeLabel?: string
  /** Opens the parent-owned confirmation dialog when the profile is removable. */
  onRemove?: (target: ProviderIdentity) => void
}

/** Render an OAuth lifecycle without exposing credential or provider details. */
export function OAuthProviderCard({
  row, controller, api, t, readOnly, removeLabel, onRemove,
}: OAuthProviderCardProps): ReactNode {
  const [deviceCode, setDeviceCode] = useState<DeviceCodeView | undefined>(undefined)
  const [pending, setPending] = useState<PendingAction | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const startGeneration = useRef(0)
  const statusRefreshInFlight = useRef(false)
  const activeStart = useRef<ActiveStart | undefined>(undefined)
  const connectionStatus = row.connection?.status ?? 'missing'
  const connecting = connectionStatus === 'connecting'
  const terminal = connectionStatus === 'connected'
    || connectionStatus === 'missing'
    || connectionStatus === 'reconnect-required'
  const disabled = readOnly || pending !== undefined
  const target = { provider: row.entry.provider, displayName: row.entry.displayName }

  const rebaseProfileCreation = (start: ActiveStart, current: ProviderRow): boolean => {
    if (
      !start.profileCreationPending
      || !current.configured
      || current.apiKeyEnv !== undefined
      || (current.connection?.status ?? 'missing') !== 'missing'
    ) {
      return false
    }
    start.entry = current.entry
    start.profileCreationPending = false
    return true
  }

  useEffect(() => {
    if (!terminal) return
    setDeviceCode(undefined)
    const start = activeStart.current
    if (start === undefined || start.entry === row.entry) return
    if (rebaseProfileCreation(start, row)) return
    startGeneration.current += 1
    activeStart.current = undefined
    setPending(current => current === 'start' ? undefined : current)
  }, [row.entry, terminal])

  useEffect(() => () => {
    startGeneration.current += 1
    activeStart.current = undefined
  }, [])

  useEffect(() => {
    if (!connecting) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      if (disposed || statusRefreshInFlight.current) return
      statusRefreshInFlight.current = true
      void controller.load().finally(() => {
        statusRefreshInFlight.current = false
        if (!disposed) timer = setTimeout(refresh, OAUTH_STATUS_REFRESH_DELAY_MS)
      })
    }
    timer = setTimeout(refresh, OAUTH_STATUS_REFRESH_DELAY_MS)
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [connecting, controller])

  const reload = async (): Promise<void> => {
    await controller.load()
  }

  const startIsCurrent = (generation: number, entry: ProviderRow['entry']): boolean => {
    const start = activeStart.current
    if (generation !== startGeneration.current || start?.generation !== generation) return false
    const current = controller.store.getSnapshot().rows
      .find(candidate => candidate.entry.provider === entry.provider)
    if (current === undefined || current.entry === start.entry) return true
    if (rebaseProfileCreation(start, current)) return true
    return current.connection?.status === 'connecting'
  }

  const connect = (): void => {
    if (disabled) return
    const generation = ++startGeneration.current
    activeStart.current = { generation, entry: row.entry, profileCreationPending: !row.configured }
    setPending('start')
    setFailure(undefined)
    void (async () => {
      try {
        if (!row.configured) {
          const profile = await api.settings.mutate({
            ns: row.entry.settingsNs,
            ops: [{ op: 'set', path: [...row.entry.settingsPath], value: {} }],
          })
          if (!startIsCurrent(generation, row.entry)) return
          if (activeStart.current?.generation === generation) activeStart.current.profileCreationPending = false
          if (!profile.result.ok) {
            setFailure(t('oauthActionFailed'))
            return
          }
        }
        const response = await api.llm.oauthStart({ provider: row.entry.provider })
        if (!startIsCurrent(generation, row.entry)) return
        if (!response.result.ok) {
          setFailure(t('oauthActionFailed'))
          return
        }
        setDeviceCode(response.result.value.start.kind === 'device-code'
          ? response.result.value.start.deviceCode
          : undefined)
      } catch {
        if (startIsCurrent(generation, row.entry)) setFailure(t('oauthActionFailed'))
      } finally {
        if (startIsCurrent(generation, row.entry)) {
          await reload()
          if (startIsCurrent(generation, row.entry)) {
            activeStart.current = undefined
            setPending(undefined)
          }
        }
      }
    })()
  }

  const cancel = (): void => {
    if (disabled) return
    setPending('cancel')
    setFailure(undefined)
    setDeviceCode(undefined)
    void (async () => {
      try {
        const response = await api.llm.oauthCancel({ provider: row.entry.provider })
        if (!response.result.ok) setFailure(t('oauthActionFailed'))
      } catch {
        setFailure(t('oauthActionFailed'))
      } finally {
        await reload()
        setPending(undefined)
      }
    })()
  }

  const disconnect = (): void => {
    if (disabled) return
    setPending('disconnect')
    setFailure(undefined)
    setDeviceCode(undefined)
    void (async () => {
      try {
        const response = await api.llm.oauthDisconnect({ provider: row.entry.provider })
        if (!response.result.ok) setFailure(t('oauthActionFailed'))
      } catch {
        setFailure(t('oauthActionFailed'))
      } finally {
        await reload()
        setPending(undefined)
      }
    })()
  }

  const copyCode = (): void => {
    if (deviceCode === undefined) return
    void navigator.clipboard.writeText(deviceCode.userCode).catch(() => { setFailure(t('oauthCopyFailed')) })
  }

  return (
    <li className={styles['rowCard']}>
      <div className={styles['rowHead']}>
        <span className={styles['rowIdentity']}>
          <span className={styles['rowName']}>{row.entry.displayName}</span>
          {connecting ? <span className={styles['oauthStatus']}>{t('oauthConnecting')}</span> : null}
          {connectionStatus === 'connected'
            ? <span className={styles['oauthStatusConnected']}>{t('oauthConnected')}</span>
            : null}
        </span>
        <span className={styles['rowActions']}>
          {connecting
            ? (
              <button type="button" className={styles['secondaryButton']} disabled={disabled} onClick={cancel}>
                {t('cancel')}
              </button>
            )
            : connectionStatus === 'connected'
              ? (
                <button type="button" className={styles['secondaryButton']} disabled={disabled} onClick={disconnect}>
                  {t('oauthDisconnect')}
                </button>
              )
              : connectionStatus === 'reconnect-required'
                ? (
                  <>
                    <button type="button" className={styles['primaryButton']} disabled={disabled} onClick={connect}>
                      {t('oauthReconnect')}
                    </button>
                    <button type="button" className={styles['secondaryButton']} disabled={disabled} onClick={disconnect}>
                      {t('oauthDisconnect')}
                    </button>
                  </>
                )
                : (
                  <button type="button" className={styles['primaryButton']} disabled={disabled} onClick={connect}>
                    {t('oauthConnect')}
                  </button>
                )}
          {onRemove === undefined || removeLabel === undefined
            ? null
            : (
              <button
                type="button"
                className={styles['dangerButton']}
                aria-label={removeLabel}
                disabled={disabled}
                onClick={() => { onRemove(target) }}
              >
                {t('remove')}
              </button>
            )}
        </span>
      </div>
      {deviceCode !== undefined && connecting
        ? (
          <div className={styles['oauthDevice']}>
            <span className={styles['oauthCodeLabel']}>{t('oauthCode')}</span>
            <code className={styles['oauthCode']}>{deviceCode.userCode}</code>
            <div className={styles['oauthDeviceActions']}>
              <a
                className={styles['oauthLink']}
                href={deviceCode.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                {t('oauthOpen')}
              </a>
              <button type="button" className={styles['linkButton']} onClick={copyCode}>
                {t('oauthCopy')}
              </button>
            </div>
          </div>
        )
        : null}
      {failure === undefined ? null : <p className={styles['error']} role="alert">{failure}</p>}
    </li>
  )
}
