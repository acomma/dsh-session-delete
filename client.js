/**
 * Browser half of the Session Delete bundle.
 *
 * Adds one destructive row to every Session's "..." menu and owns the
 * confirmation dialog. Both the menu row and the dialog live in slots owned by
 * the shipped Workspace browser and shell overlay; this module only projects
 * its own state into them. Deletion itself is the Host route
 * `api/session.delete`, which applies the live-Session refusal.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-delete'
    const ROUTE = 'api/session.delete'

    const zh = {
      'menu.delete': '删除会话',
      'dialog.title': '永久删除会话？',
      'dialog.description': '将永久删除「{title}」及其所有子会话的存储日志。',
      'dialog.warning': '此操作无法撤销。会话日志会被删除；附件默认一并清理，仍被其他会话引用的会保留。',
      'dialog.attachments': '同时删除附件',
      'dialog.attachmentsHint': '只删除不再被其他会话引用的附件；仍被引用的附件会保留，附件缓存不清理。',
      'dialog.attachmentsSummaryDeleted': '附件：已删除 {n} 个，释放 {size}。',
      'dialog.attachmentsSummaryGone': '附件：要清理的附件对象已不存在。',
      'dialog.attachmentsSummaryNone': '附件：没有需要清理的附件。',
      'dialog.attachmentsSummaryKept': '{n} 个附件仍被其他会话引用，已保留。',
      'dialog.attachmentsSummaryFailed': '{n} 个附件未能删除。',
      'dialog.attachmentsUnverified': '未能核对其他会话的附件引用，所有附件均已保留。',
      'dialog.untitled': '未命名会话',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.deleting': '正在删除…',
      'dialog.deletingAttachments': '正在删除并核对附件…',
      'dialog.successTitle': '会话已删除',
      'dialog.successDescription': '存储日志已从磁盘删除，侧边栏行已移除。若 DSH 顺带打开了相邻会话，它会被预热；该会话同样需要重启 Harness 后才能删除。',
      'dialog.close': '关闭',
      'error.live': '该会话已被 DSH 在后台激活：打开过一次的会话会预热一个 Agent，并持有日志的写入句柄；Host 进程内没有释放入口。请重启 Harness 后再删除（刷新页面无效）。',
      'error.liveJob': '该会话还有运行中的后台任务，请先停止它们再删除。',
      'error.not-found': '该会话不存在或已被删除。',
      'error.invalid-id': '会话 ID 无效。',
      'error.invalid-request': '删除请求无效。',
      'error.directory-missing': '找不到该会话的存储目录，可能已被外部删除。',
      'error.delete-failed': '无法删除会话目录，可能有其他进程正在读取它。',
      'error.partial': '部分文件未能删除；已删除的会话可能不完整，请稍后重试。',
      'error.unavailable': '会话存储服务不可用。',
      'error.network': '无法连接到本地 Harness 服务。',
      'error.http': '删除请求失败（HTTP {status}）。',
    }

    const en = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Delete this session permanently?',
      'dialog.description': 'Permanently deletes the stored log of "{title}" and of all its sub-sessions.',
      'dialog.warning': 'This cannot be undone. Session logs are deleted; attachments are cleaned up too unless you clear the option below.',
      'dialog.attachments': 'Also delete attachments',
      'dialog.attachmentsHint': 'Deletes only attachments no other session references. Shared attachments are kept; the attachment cache is not cleared.',
      'dialog.attachmentsSummaryDeleted': 'Attachments: {n} deleted, {size} freed.',
      'dialog.attachmentsSummaryGone': 'Attachments: nothing was left to clean up on disk.',
      'dialog.attachmentsSummaryNone': 'Attachments: there was nothing to clean up.',
      'dialog.attachmentsSummaryKept': '{n} attachments are still referenced by other sessions and were kept.',
      'dialog.attachmentsSummaryFailed': '{n} attachments could not be deleted.',
      'dialog.attachmentsUnverified': 'Attachment references of other sessions could not be verified, so every attachment was kept.',
      'dialog.untitled': 'Untitled session',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.deleting': 'Deleting…',
      'dialog.deletingAttachments': 'Deleting and checking attachments…',
      'dialog.successTitle': 'Session deleted',
      'dialog.successDescription': 'The stored log was deleted and its sidebar row removed. If DSH opened a neighbouring session, that session is pre-warmed and will also need a Harness restart before it can be deleted.',
      'dialog.close': 'Close',
      'error.live': 'DSH activated this session in the background: opening a session once pre-warms an Agent that holds the log write handle, and the Host process exposes no way to release it. Restart Harness, then delete it (reloading the page does not help).',
      'error.liveJob': 'This session still has running background jobs. Stop them before deleting it.',
      'error.not-found': 'This session does not exist or was already deleted.',
      'error.invalid-id': 'The session id is invalid.',
      'error.invalid-request': 'The delete request was invalid.',
      'error.directory-missing': 'The stored session directory could not be found; it may have been removed externally.',
      'error.delete-failed': 'The session directory could not be deleted; another process may be reading it.',
      'error.partial': 'Some files could not be deleted; the session may be partially deleted. Try again later.',
      'error.unavailable': 'The session persistence service is unavailable.',
      'error.network': 'Could not reach the local Harness service.',
      'error.http': 'The delete request failed (HTTP {status}).',
    }

    /** One pending confirmation, shared by the menu row and the overlay dialog. */
    let state = {
      open: false,
      phase: 'confirm',
      sessionId: null,
      title: '',
      error: null,
      /** Attachment cleanup; on by default on every new confirmation. */
      deleteAttachments: true,
      /** Attachment report of the last successful deletion, when one ran. */
      attachments: null,
    }
    const listeners = new Set()

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function snapshot() {
      return state
    }

    function publish(patch) {
      state = { ...state, ...patch }
      for (const listener of [...listeners]) listener()
    }

    function useDeleteState() {
      return React.useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    function requestDelete(sessionId, displayTitle) {
      publish({
        open: true,
        phase: 'confirm',
        sessionId,
        title: typeof displayTitle === 'string' ? displayTitle : '',
        error: null,
        deleteAttachments: true,
        attachments: null,
      })
    }

    function dismiss() {
      if (state.phase === 'deleting') return
      publish({
        open: false,
        phase: 'confirm',
        sessionId: null,
        title: '',
        error: null,
        deleteAttachments: true,
        attachments: null,
      })
    }

    /**
     * Ask the Host to delete one Session.
     * @param sessionId - the stored Session to remove.
     * @param deleteAttachments - whether to also reclaim its unshared attachment objects.
     * @returns the parsed answer, with the attachment report under `data.attachments`.
     */
    async function postDelete(sessionId, deleteAttachments) {
      const controller = new AbortController()
      const budget = deleteAttachments === true ? 180000 : 30000
      const timer = setTimeout(() => controller.abort(), budget)
      let response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(deleteAttachments === true ? { sessionId, deleteAttachments: true } : { sessionId }),
          signal: controller.signal,
        })
      } catch (error) {
        return { ok: false, code: 'network', message: error instanceof Error ? error.message : String(error) }
      } finally {
        clearTimeout(timer)
      }
      let data = null
      try {
        data = await response.json()
      } catch {
        /* an empty or non-JSON answer is reported through the status */
      }
      if (response.ok && data?.ok === true) return { ok: true, data }
      return {
        ok: false,
        code: typeof data?.code === 'string' ? data.code : 'http',
        status: response.status,
        message: typeof data?.message === 'string' ? data.message : '',
      }
    }

    function errorText(result, t) {
      switch (result.code) {
        case 'live':
          return result.reason === 'job' ? t('error.liveJob') : t('error.live')
        case 'not-found':
          return t('error.not-found')
        case 'invalid-id':
          return t('error.invalid-id')
        case 'invalid-request':
          return t('error.invalid-request')
        case 'directory-missing':
          return t('error.directory-missing')
        case 'delete-failed':
          return t('error.delete-failed')
        case 'partial':
          return t('error.partial')
        case 'unavailable':
          return t('error.unavailable')
        case 'network':
          return t('error.network')
        default:
          return result.message !== ''
            ? result.message
            : t('error.http', { status: String(result.status ?? 0) })
      }
    }

    /**
     * The trash glyph the shipped "Delete workspace" row renders
     * (ui-primitives `IconTrashOutlineRegular`): a 16-unit outline drawn one
     * pixel wide, with the same five strokes, so both delete rows read as one
     * icon family. Copied rather than imported — a client bundle must not
     * require a Harness Client package.
     */
    function DeleteIcon() {
      return h('svg', {
        className: 'dsh-session-delete__menu-icon',
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
        strokeWidth: 1,
      },
      h('path', { d: 'M1.28149 3.88831H14.7187', stroke: 'currentColor' }),
      h('path', {
        d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
        stroke: 'currentColor',
      }),
      h('path', {
        d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
        stroke: 'currentColor',
      }),
      h('path', { d: 'M6.44946 6.98926V11.1238', stroke: 'currentColor' }),
      h('path', { d: 'M9.55054 6.98926V11.1238', stroke: 'currentColor' }))
    }

    /** One destructive row at the end of a Session's "..." menu. */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, requestDelete: openDelete, t: translate } = props
      const t = typeof translate === 'function' ? translate : (key) => key
      const [, setMenuOpen] = useMenuOpenState()
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-session-delete__menu-item',
        onClick: () => {
          setMenuOpen(false)
          openDelete(sessionId, displayTitle)
        },
      },
      h(DeleteIcon),
      h('span', { className: 'dsh-session-delete__menu-label' }, t('menu.delete')))
    }

    /** Byte count in the dialog's compact unit form. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
      return `${shown} ${units[unit]}`
    }

    /**
     * One paragraph describing what the attachment cleanup did, or why it kept
     * everything. Only the Host can count references, so its report is the
     * single source for these numbers.
     * @param report - the `attachments` field of a successful deletion.
     * @param t - the dialog's translate seat.
     * @returns the summary element, or null when the cleanup did not run.
     */
    function attachmentSummary(report, t) {
      if (report === null || report === undefined) return null
      if (report.status !== 'applied') {
        return h('p', { key: 'attachments', className: 'dsh-session-delete__warning' }, t('dialog.attachmentsUnverified'))
      }
      const parts = []
      if (report.deleted > 0) {
        parts.push(t('dialog.attachmentsSummaryDeleted', { n: String(report.deleted), size: formatBytes(report.bytes) }))
      } else if (report.missing > 0) {
        parts.push(t('dialog.attachmentsSummaryGone'))
      } else {
        parts.push(t('dialog.attachmentsSummaryNone'))
      }
      if (report.kept > 0) parts.push(t('dialog.attachmentsSummaryKept', { n: String(report.kept) }))
      if (report.failed > 0) parts.push(t('dialog.attachmentsSummaryFailed', { n: String(report.failed) }))
      return h('p', { key: 'attachments', className: 'dsh-session-delete__body' }, parts.join(' '))
    }

    /** Frame-wide confirmation and success dialog. */
    function DeleteSessionDialog({ t: translate }) {
      const t = typeof translate === 'function' ? translate : (key) => key
      const current = useDeleteState()
      const cancelRef = React.useRef(null)
      const closeRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      const restoreRef = React.useRef(null)
      const phaseRef = React.useRef(current.phase)
      phaseRef.current = current.phase

      React.useEffect(() => {
        if (!current.open) return undefined
        const previous = document.activeElement
        restoreRef.current = previous
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'

        const onKeyDown = (event) => {
          if (event.key === 'Escape' && phaseRef.current !== 'deleting') {
            event.preventDefault()
            dismiss()
            return
          }
          if (event.key !== 'Tab' || dialogRef.current === null) return
          const focusable = dialogRef.current.querySelectorAll(
            'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          )
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }

        document.addEventListener('keydown', onKeyDown)
        const frame = requestAnimationFrame(() => {
          if (cancelRef.current !== null) cancelRef.current.focus()
        })
        return () => {
          cancelAnimationFrame(frame)
          document.removeEventListener('keydown', onKeyDown)
          document.body.style.overflow = previousOverflow
          restoreRef.current = null
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [current.open])

      React.useEffect(() => {
        if (current.open && current.phase === 'success' && closeRef.current !== null) {
          closeRef.current.focus()
        }
      }, [current.open, current.phase])

      if (!current.open) return null

      const success = current.phase === 'success'
      const deleting = current.phase === 'deleting'
      const title = current.title === '' ? t('dialog.untitled') : current.title

      const onConfirm = async () => {
        if (phaseRef.current === 'deleting') return
        const sessionId = current.sessionId
        const deleteAttachments = current.deleteAttachments
        publish({ phase: 'deleting', error: null })
        const result = await postDelete(sessionId, deleteAttachments)
        if (result.ok) {
          publish({ phase: 'success', error: null, attachments: result.data?.attachments ?? null })
          return
        }
        publish({ phase: 'confirm', error: result })
      }

      const option = h('label', {
        key: 'attachments',
        className: 'dsh-session-delete__option',
      },
      h('input', {
        type: 'checkbox',
        className: 'dsh-session-delete__checkbox',
        checked: current.deleteAttachments === true,
        disabled: deleting,
        onChange: (event) => publish({ deleteAttachments: event.target.checked === true }),
      }),
      h('span', { className: 'dsh-session-delete__optionText' },
        h('span', { className: 'dsh-session-delete__optionTitle' }, t('dialog.attachments')),
        h('span', { className: 'dsh-session-delete__optionHint' }, t('dialog.attachmentsHint'))))

      const body = success
        ? [
            h('p', { key: 'success', className: 'dsh-session-delete__body' }, t('dialog.successDescription')),
            attachmentSummary(current.attachments, t),
          ]
        : [
            h('p', { key: 'description', className: 'dsh-session-delete__body' }, t('dialog.description', { title })),
            h('p', { key: 'warning', className: 'dsh-session-delete__warning' }, t('dialog.warning')),
            option,
            current.error === null
              ? null
              : h('p', { key: 'error', className: 'dsh-session-delete__error', role: 'alert' }, errorText(current.error, t)),
          ]

      const actions = success
        ? [
            h('button', {
              key: 'close',
              ref: closeRef,
              type: 'button',
              className: 'dsh-session-delete__button dsh-session-delete__button--primary',
              onClick: dismiss,
              autoFocus: true,
            }, t('dialog.close')),
          ]
        : [
            h('button', {
              key: 'cancel',
              ref: cancelRef,
              type: 'button',
              className: 'dsh-session-delete__button',
              onClick: dismiss,
              disabled: deleting,
            }, t('dialog.cancel')),
            h('button', {
              key: 'confirm',
              type: 'button',
              className: 'dsh-session-delete__button dsh-session-delete__button--danger',
              onClick: onConfirm,
              disabled: deleting,
            }, deleting
              ? (current.deleteAttachments === true ? t('dialog.deletingAttachments') : t('dialog.deleting'))
              : t('dialog.confirm')),
          ]

      return h('div', {
        className: 'dsh-session-delete__scrim',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && !deleting) dismiss()
        },
      }, h('div', {
        ref: dialogRef,
        className: 'dsh-session-delete__dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dsh-session-delete-title',
        'aria-describedby': 'dsh-session-delete-body',
      },
      h('h2', {
        id: 'dsh-session-delete-title',
        className: 'dsh-session-delete__title',
      }, success ? t('dialog.successTitle') : t('dialog.title')),
      h('div', { id: 'dsh-session-delete-body' }, body),
      h('div', { className: 'dsh-session-delete__actions' }, actions)))
    }

    const CSS = `
.dsh-session-delete__menu-item {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  margin: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: start;
  cursor: pointer;
}
.dsh-session-delete__menu-icon {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
}
.dsh-session-delete__menu-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-session-delete__menu-item:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}
.dsh-session-delete__menu-item:focus-visible {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  outline: none;
}
.dsh-session-delete__scrim {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 32%, transparent);
  pointer-events: auto;
}
.dsh-session-delete__dialog {
  box-sizing: border-box;
  width: min(440px, 100%);
  padding: 20px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 16px 48px color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);
}
.dsh-session-delete__title {
  margin: 0 0 10px;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.dsh-session-delete__body {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.dsh-session-delete__warning {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-session-delete__option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.dsh-session-delete__checkbox {
  flex: none;
  width: 14px;
  height: 14px;
  margin: 3px 0 0;
  accent-color: var(--dsw-alias-state-error-primary);
  cursor: pointer;
}
.dsh-session-delete__checkbox:disabled {
  cursor: default;
}
.dsh-session-delete__optionText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh-session-delete__optionHint {
  color: var(--dsw-alias-label-secondary);
}
.dsh-session-delete__error {
  margin: 12px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-session-delete__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.dsh-session-delete__button {
  box-sizing: border-box;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.dsh-session-delete__button:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-session-delete__button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dsh-session-delete__button:disabled {
  opacity: 0.55;
  cursor: default;
}
.dsh-session-delete__button--primary {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
}
.dsh-session-delete__button--danger {
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-bg-base);
}
.dsh-session-delete__button--primary:hover {
  background: var(--dsw-alias-brand-primary);
  opacity: 0.9;
}
.dsh-session-delete__button--danger:hover {
  background: var(--dsw-alias-state-error-primary);
  opacity: 0.9;
}
`

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = NS
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'session-delete: styles')

      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-delete: dictionaries')

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-delete.menu',
        order: 500,
        locale: NS,
        inject: () => ({ requestDelete }),
      }, DeleteSessionMenuItem))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-delete.dialog',
        order: 60,
        locale: NS,
      }, DeleteSessionDialog))
    }

    return { inject, apply }
  },
})
