/**
 * Browser half of the Session Delete bundle.
 *
 * Adds one destructive row to every Session's "..." menu and owns the
 * confirmation dialog. Both the menu row and the dialog live in slots owned by
 * the shipped Workspace browser and shell overlay; this module only projects
 * its own state into them. The row and dialog reuse the shipped ui-primitives
 * so they behave like the built-in archive and delete surfaces. Deletion itself
 * is the Host route `api/session.delete`, which applies the live-Session
 * refusal.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const { Button, IconTrashOutlineRegular, MenuItemButton, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')
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
      'dialog.successDescription': '存储日志已从磁盘删除，侧边栏行已移除。',
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
      'dialog.successDescription': 'The stored log was deleted and its sidebar row removed.',
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

    /** One closed confirmation: the shared starting point for every transition. */
    const CLOSED = Object.freeze({
      open: false,
      phase: 'confirm',
      sessionId: null,
      title: '',
      error: null,
      /** Attachment cleanup; on by default on every new confirmation. */
      deleteAttachments: true,
      /** Attachment report of the last successful deletion, when one ran. */
      attachments: null,
    })
    /** One pending confirmation, shared by the menu row and the overlay dialog. */
    let state = CLOSED
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
        ...CLOSED,
        open: true,
        sessionId,
        title: typeof displayTitle === 'string' ? displayTitle : '',
      })
    }

    function dismiss() {
      if (state.phase === 'deleting') return
      publish(CLOSED)
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
          body: JSON.stringify({ sessionId, deleteAttachments: deleteAttachments === true }),
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

    /** One destructive row at the end of a Session's "..." menu. */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, requestDelete: openDelete, t: translate } = props
      const t = typeof translate === 'function' ? translate : (key) => key
      const [, setMenuOpen] = useMenuOpenState()
      return h(MenuItemButton, {
        danger: true,
        icon: h(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false)
          openDelete(sessionId, displayTitle)
        },
      }, t('menu.delete'))
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

    /** Frame-wide confirmation and success dialog, rendered by the shipped Modal. */
    function DeleteSessionDialog({ t: translate }) {
      const t = typeof translate === 'function' ? translate : (key) => key
      const current = useDeleteState()
      if (!current.open) return null

      const success = current.phase === 'success'
      const deleting = current.phase === 'deleting'
      const title = current.title === '' ? t('dialog.untitled') : current.title

      const onConfirm = async () => {
        if (state.phase === 'deleting') return
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

      const footer = success
        ? h(Button, { key: 'close', variant: 'primary', autoFocus: true, onClick: dismiss }, t('dialog.close'))
        : h(React.Fragment, null,
            h(Button, {
              key: 'cancel',
              variant: 'outline',
              disabled: deleting,
              'data-modal-autofocus': true,
              onClick: dismiss,
            }, t('dialog.cancel')),
            h(Button, {
              key: 'confirm',
              variant: 'outline',
              className: 'dsh-session-delete__danger',
              disabled: deleting,
              onClick: onConfirm,
            }, deleting
              ? (current.deleteAttachments === true ? t('dialog.deletingAttachments') : t('dialog.deleting'))
              : t('dialog.confirm')))

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
        h('span', null, t('dialog.attachments')),
        h('span', { className: 'dsh-session-delete__optionHint' }, t('dialog.attachmentsHint'))))

      const summary = success ? attachmentSummary(current.attachments, t) : null
      const body = success
        ? (summary === null ? [] : [summary])
        : [
            h('p', { key: 'warning', className: 'dsh-session-delete__warning' }, t('dialog.warning')),
            option,
            current.error === null
              ? null
              : h('p', { key: 'error', className: 'dsh-session-delete__error', role: 'alert' }, errorText(current.error, t)),
          ]

      return h(Modal, {
        open: true,
        onClose: dismiss,
        closeLabel: t('dialog.close'),
        title: success ? t('dialog.successTitle') : t('dialog.title'),
        description: success
          ? t('dialog.successDescription')
          : t('dialog.description', { title }),
        footer,
      }, ...body)
    }

    const CSS = `
.dsh-session-delete__warning {
  margin: 0 0 14px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-session-delete__body {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.dsh-session-delete__option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
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
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-session-delete__danger:not(:disabled) {
  color: var(--dsw-alias-state-error-primary);
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
