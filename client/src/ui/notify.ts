// Notificações (opt-in): Notification do navegador para alertas com a aba oculta, sons de aviso
// (sino de "precisa de você", estalo de conclusão; pela mesa de som da UI) e o contador no título da
// aba quando há agentes esperando você.
import type { Notice } from '../../../shared/types';
import type { SoundBoard } from '../audio/board';
import type { UiComponent, UiContext } from './context';
import { computeCounters } from './model';
import { tr } from '../../../shared/i18n';

const BASE_TITLE = 'Habblaud';

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

export function isSecureConnection(): boolean {
  if (typeof window === 'undefined') return true;
  return window.isSecureContext === true;
}

export function notificationState(): NotificationState {
  if (typeof Notification === 'undefined' || !isSecureConnection()) return 'unsupported';
  return Notification.permission;
}

export class Notifier implements UiComponent {
  private lastTitle = '';

  constructor(
    private ctx: UiContext,
    private sounds: SoundBoard,
  ) {
    ctx.store.on('notice', (n) => this.onNotice(n));
  }

  /** Pede permissão de notificação ao ligar a opção. Devolve o estado final. */
  async enableBrowserNotifications(): Promise<NotificationState> {
    const state = notificationState();
    if (state === 'unsupported' || state === 'denied' || state === 'granted') return state;
    try {
      return await Notification.requestPermission();
    } catch {
      return notificationState();
    }
  }

  render(): void {
    // Ao vivo, mesmo durante o timelapse: o título da aba avisa quem precisa de você agora.
    const waiting = computeCounters(this.ctx.store.liveSnapshot).waiting;
    const title = waiting > 0 ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE;
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      document.title = title;
    }
  }

  private onNotice(n: Notice): void {
    const prefs = this.ctx.prefs;
    // o sino toca mesmo com a aba oculta (é ele que chama você de volta); o estalo, só com ela à vista
    if (n.level === 'alert') this.sounds.play('chime');
    else if (n.level === 'success') this.sounds.play('pop');
    const wantsBrowserNotif = prefs.browserNotifications && notificationState() === 'granted';
    // "alert" = precisa de você (permissão, pergunta). "success" = agente concluiu.
    // Browser notification fires only when the tab is hidden to avoid double feedback.
    if (wantsBrowserNotif && document.hidden && (n.level === 'alert' || n.level === 'success')) {
      const title =
        n.level === 'alert' ? tr('Habblaud — precisa de você') : tr('Habblaud — tarefa concluída');
      try {
        const notification = new Notification(title, {
          body: n.text,
          tag: n.agentId ?? n.id,
          icon: '/assets/brand/favicon-32.png',
        });
        notification.onclick = () => {
          window.focus();
          if (n.agentId && this.ctx.agent(n.agentId)) this.ctx.select({ type: 'agent', id: n.agentId }, { focus: true });
          notification.close();
        };
      } catch {
        // Alguns navegadores só permitem notificações via service worker; o toast continua aparecendo.
      }
    }
  }
}
