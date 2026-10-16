/* app/router/router-service.ts — routes hash changes to session service. */

import { parseHash, buildRadioHash } from './router.js';
import { SessionService } from '../session/session-service.js';

export interface RouterServiceDeps {
  session: SessionService;
  showScreen: (name: 'radio' | 'join' | 'settings') => void;
  refreshSettings: () => void;
  prefillJoin: (channel: string | null) => void;
}

export function initRouter(deps: RouterServiceDeps): void {
  window.addEventListener('hashchange', () => route(deps));
  route(deps);
}

function route(deps: RouterServiceDeps): void {
  const { session, showScreen, refreshSettings, prefillJoin } = deps;
  const r = parseHash(location.hash);

  switch (r.type) {
    case 'settings':
      showScreen('settings');
      refreshSettings();
      break;

    case 'radio':
      if (session.getState().phase === 'joined' &&
          session.getState().channel === r.channel &&
          session.getState().secret === r.secret) {
        showScreen('radio');
        return;
      }
      if (session.getState().phase === 'joined') {
        showScreen('radio');
        session.rejoin(r.channel, r.secret).then((ok) => {
          if (ok) history.replaceState(null, '', buildRadioHash(r.channel, r.secret));
        }).catch(() => { void session.leave().catch(() => {}); });   // a rejecting rejoin goes back to the join screen
      } else {
        showScreen('radio');
        session.initFromHash(r.channel, r.secret).then((ok) => {
          if (ok) history.replaceState(null, '', buildRadioHash(r.channel, r.secret));
        }).catch(() => { void session.leave().catch(() => {}); });
      }
      break;

    case 'join':
      /* '#', '#c=22', or any non-radio hash means: not on the air.
         Teardown is session-owned — route first, then leave. */
      if (session.getState().phase !== 'idle') void session.leave();
      prefillJoin(r.channel ?? null);
      showScreen('join');
      break;
  }
}