import { ref } from 'vue'

// 守护台统一 DIV 弹窗：替代 window.confirm / alert，所有确认类交互走这一套。
// 用法：const ok = await confirmDialog({ title, message, danger: true })
// 组件 UiDialog.vue 挂载在 App.vue 根部读取 uiDialogState 渲染。

export interface UiDialogOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  showCancel?: boolean
}

export interface UiDialogState {
  title: string
  message: string
  confirmText: string
  cancelText: string
  danger: boolean
  showCancel: boolean
  resolve: (result: boolean) => void
}

const uiDialogState = ref<UiDialogState | null>(null)

export function useUiDialogState() {
  return uiDialogState
}

export function confirmDialog(options: UiDialogOptions): Promise<boolean> {
  // 已有弹窗未处理时先按取消结算，避免 Promise 悬挂
  if (uiDialogState.value) resolveUiDialog(false)
  return new Promise((resolve) => {
    uiDialogState.value = {
      title: String(options.title || '请确认'),
      message: String(options.message || ''),
      confirmText: String(options.confirmText || '确认'),
      cancelText: String(options.cancelText || '取消'),
      danger: options.danger === true,
      showCancel: options.showCancel !== false,
      resolve
    }
  })
}

export function alertDialog(message: string, title = '提示'): Promise<boolean> {
  return confirmDialog({ title, message, confirmText: '知道了', showCancel: false })
}

export function resolveUiDialog(result: boolean) {
  const state = uiDialogState.value
  uiDialogState.value = null
  state?.resolve(result)
}
