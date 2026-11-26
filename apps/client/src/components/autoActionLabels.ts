import type { AutoActionErrorCode, AutoActionFileError, AutoActionStep } from '../engine/ActionRecorder';
import type { Language, Translations } from '../locales';
import { filterLabel, filterParamLabel, getFilter, paramShown, type FilterParam } from '../utils/filterRegistry';

export function formatAutoActionLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? String(values[key]) : token);
}

export function describeAutoActionError(code: AutoActionErrorCode, t: Translations): string {
  return t.autoActions.errors[code];
}

export function describeAutoActionImportError(code: AutoActionFileError['code'], t: Translations): string {
  return t.autoActions.importError[code];
}

export function describeAutoActionStep(step: AutoActionStep, t: Translations, language?: Language): string {
  const { steps, params, layerNames } = t.autoActions;
  const formatValue = (template: string, value: string | number) => formatAutoActionLabel(template, { value });
  const blend = (mode: string) => {
    const key = mode.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as keyof Translations['blendModes'];
    return formatValue(params.blend, Object.hasOwn(t.blendModes, key) ? t.blendModes[key] : mode);
  };
  const opacity = (value: number) => formatValue(params.opacity, Math.round(value * 100));
  const clip = (enabled: boolean) => enabled ? params.clippingOn : params.clippingOff;
  switch (step.kind) {
    case 'layer.new': {
      const { name, nameKey, blendMode, opacity: value, clipToBelow } = step.params;
      return [
        steps[step.kind],
        name ?? (nameKey && layerNames[nameKey]),
        blendMode && blend(blendMode),
        value === undefined ? undefined : opacity(value),
        clipToBelow === undefined ? undefined : clip(clipToBelow),
      ].filter(Boolean).join(' · ');
    }
    case 'layer.set_blend':
      return blend(step.params.blendMode);
    case 'layer.set_opacity':
      return opacity(step.params.opacity);
    case 'layer.set_clip':
      return clip(step.params.clipToBelow);
    case 'filter.apply': {
      const { filterId, values } = step.params;
      const def = getFilter(filterId);
      if (!def) return [steps[step.kind], filterId].join(' · ');
      const param = def.params.find((item) => item.kind === 'range' && paramShown(item, values) && typeof values[item.key] === 'number');
      const summary = param && [filterParamLabel(param, t, language) || param.key, describeAutoActionFilterValue(param, values[param.key], t, language)].join(' ');
      return [filterLabel(def, t, language), summary].filter(Boolean).join(' · ');
    }
    case 'adjustment.create':
      return [steps[step.kind], t.layers.adjustment.kinds[step.params.adjustment.kind]].join(' · ');
    case 'selection.grow':
      return formatValue(step.params.px > 0 ? params.grow : params.shrink, Math.abs(step.params.px));
    default:
      return steps[step.kind];
  }
}

export function describeAutoActionFilterValue(param: FilterParam, value: unknown, t: Translations, language?: Language): string {
  if (typeof value === 'boolean') return value ? t.autoActions.params.on : t.autoActions.params.off;
  if (typeof value === 'number') return param.unit ? `${value} ${param.unit}` : String(value);
  if (typeof value === 'string') {
    const option = param.kind === 'select' ? param.options.find((item) => item.value === value) : undefined;
    return option ? filterParamLabel(option, t, language) || value : value;
  }
  return JSON.stringify(value) ?? '';
}
