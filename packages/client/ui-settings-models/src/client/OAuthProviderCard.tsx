/** OAuth-specific provider card with page-local device-code instructions. */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsSectionInjected, ProviderIdentity } from './ModelsSection.tsx'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import styles from './ModelsSection.module.css'

interface DeviceCodeView {
  verificationUri: string
  userCode: string
}

type PendingAction = 'start' | 'cancel' | 'disconnect'

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
  const connectionStatus = row.entry.connection?.status ?? 'missing'
  const connecting = connectionStatus === 'connecting' || pending === 'start'
  const disabled = readOnly || pending !== undefined
  const target = { provider: row.entry.provider, displayName: row.entry.displayName }

  useEffect(() => {
    if (!connecting) setDeviceCode(undefined)
  }, [connecting])

  const reload = async (): Promise<void> => {
    await controller.load()
  }

  const connect = (): void => {
    if (disabled) return
    setPending('start')
    setFailure(undefined)
    void (async () => {
      try {
        if (!row.configured) {
          const profile = await api.settings.mutate({
            ns: row.entry.settingsNs,
            ops: [{ op: 'set', path: [...row.entry.settingsPath], value: {} }],
          })
          if (!profile.result.ok) {
            setFailure(t('oauthActionFailed'))
            return
          }
        }
        const response = await api.llm.oauthStart({ provider: row.entry.provider })
        if (!response.result.ok) {
          setFailure(t('oauthActionFailed'))
          return
        }
        setDeviceCode(response.result.value.start.kind === 'device-code'
          ? response.result.value.start.deviceCode
          : undefined)
      } catch {
        setFailure(t('oauthActionFailed'))
      } finally {
        await reload()
        setPending(undefined)
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
