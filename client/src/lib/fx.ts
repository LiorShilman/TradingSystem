import { FX_SOURCE_LABELS, formatIsrael, type FxSnapshot } from '@trading/shared';

/** "בנק ישראל (שער יציג) · 26/11 15:23" */
export function fxSourceLabel(fx: FxSnapshot): string {
  const when = formatIsrael(fx.asOf, fx.asOfHasTime ? 'dd/MM HH:mm' : 'dd/MM/yyyy');
  return `${FX_SOURCE_LABELS[fx.source]} · ${when}`;
}
