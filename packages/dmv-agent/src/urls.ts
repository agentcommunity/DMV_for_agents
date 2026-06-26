import type { RegistrationResult } from './types.js';

const DMV_BASE_URL = 'https://dmv.agentcommunity.org';
const DMV_PERMALINK_BASE_URL = 'https://dmv.agentcommunity.org/c/';

export interface RegistrationUrls {
  permalinkUrl: string;
  badgeUrl: string;
  badgeCardUrl: string;
  viewUrl: string;
  cardImageUrl: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function withoutProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

export function resolveRegistrationUrls(result: RegistrationResult): RegistrationUrls {
  const cert = encodeURIComponent(result.certificateId);
  const agent = encodeURIComponent(result.agentName);
  const permalinkUrl = isNonEmptyString(result.permalinkUrl)
    ? result.permalinkUrl
    : `${DMV_PERMALINK_BASE_URL}${cert}/${agent}`;
  const badgeUrl = isNonEmptyString(result.badgeUrl)
    ? result.badgeUrl
    : `${DMV_BASE_URL}/badge?id=${cert}`;
  const badgeCardUrl = isNonEmptyString(result.badgeCardUrl)
    ? result.badgeCardUrl
    : `${DMV_BASE_URL}/badge?id=${cert}&style=card`;

  return {
    permalinkUrl,
    badgeUrl,
    badgeCardUrl,
    viewUrl: withoutProtocol(permalinkUrl),
    cardImageUrl: `${DMV_BASE_URL}/api/card?id=${cert}&name=${agent}`,
  };
}
