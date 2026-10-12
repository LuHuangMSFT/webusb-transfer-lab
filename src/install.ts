import { diagnosticError } from './diagnostics'

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: InstallPromptEvent
    appinstalled: Event
  }
}

export function setupInstall(button: HTMLButtonElement, status: HTMLElement, changed: () => void) {
  const standalone = window.matchMedia('(display-mode: standalone)')
  let installed = standalone.matches
  let pending: InstallPromptEvent | undefined
  let prompting = false

  function announce(text: string): void {
    status.textContent = text
    status.hidden = !text
  }

  if (installed) announce('Running as an app in the browser that installed it.')

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    if (installed) return
    pending = event
    changed()
  })

  window.addEventListener('appinstalled', () => {
    installed = true
    pending = undefined
    announce('App installed. Launch WebUSB Transfer Lab from your apps when ready.')
    changed()
  })

  standalone.addEventListener('change', () => {
    if (!standalone.matches) return
    installed = true
    pending = undefined
    announce('Running as an app in the browser that installed it.')
    changed()
  })

  button.addEventListener('click', async () => {
    if (button.disabled || !pending || prompting || installed) return
    const event = pending
    pending = undefined
    prompting = true
    changed()
    announce('Finish installation in the browser prompt.')
    try {
      // Invoke in the click handler to preserve the required user gesture.
      const [, choice] = await Promise.all([event.prompt(), event.userChoice])
      if (!installed) announce(choice.outcome === 'accepted'
        ? 'Installation requested. Finish in your browser before launching the app.'
        : 'Installation canceled. You can install later from the browser menu.')
    } catch (error) {
      diagnosticError('app.install.failed', 'Installation prompt failed. Use the browser install menu instead.', error)
      announce('Could not open or complete the install prompt. Use the browser install menu instead.')
    } finally {
      prompting = false
      changed()
    }
  })

  return {
    get prompting() { return prompting },
    refresh(blocked: boolean): void {
      button.hidden = installed || (!pending && !prompting)
      button.disabled = blocked || prompting
      button.title = blocked ? 'Disconnect the phone and finish any active work before installing.' : 'Install WebUSB Transfer Lab'
    },
  }
}
