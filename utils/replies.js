const DISCORD_LINK_RE = /^https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/;

//5000 messages
export class BoundedMap {
	constructor(max = 5000) {
		this.max = max;
		this.map = new Map();
	}
	set(key, value) {
		this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.max) {
			this.map.delete(this.map.keys().next().value);
		}
	}
	get(key) {
		return this.map.get(key);
	}
}

//idk
export function hiddenDiscordLink(guildId, channelId, messageId) {
	return `[​](https://discord.com/channels/${guildId}/${channelId}/${messageId})`;
}

//idk
export function findDiscordLink(telegramMessage) {
	const entities = [...(telegramMessage.entities ?? []), ...(telegramMessage.caption_entities ?? [])];
	for (const entity of entities) {
		if (entity.type === 'text_link' && entity.url) {
			const match = DISCORD_LINK_RE.exec(entity.url);
			if (match) {
				return { guildId: match[1], channelId: match[2], messageId: match[3] };
			}
		}
	}
	return null;
}

export function neutralizeLinks(text) {
	return text.replace(/(?<!<)(https?:\/\/[^\s<>)]+)/g, '<$1>');
}

export function makeQuote(text, { maxChars = 200, maxLines = 4 } = {}) {
	let t = (text ?? '').replace(/```/g, "'''").trim();
	if (!t) {
		return '';
	}
	let truncated = false;
	let lines = t.split('\n');
	if (lines.length > maxLines) {
		lines = lines.slice(0, maxLines);
		truncated = true;
	}
	t = lines.join('\n');
	if (t.length > maxChars) {
		t = t.slice(0, maxChars);
		truncated = true;
	}
	t = neutralizeLinks(t);
	if (truncated) {
		t = t.trimEnd() + '…';
	}
	return t.split('\n').map((line) => '> ' + line).join('\n');
}

export function escapeDiscordMd(text) {
	return text.replace(/([\\*_~|`>])/g, '\\$1');
}

export function escapeTelegramMd(text) {
	return text.replace(/([_*`\[])/g, '\\$1');
}

export function snippet(text, max = 80) {
	const t = (text ?? '').replace(/\s+/g, ' ').trim();
	return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

export function telegramDisplayName(user, fallback = 'someone') {
	if (!user) {
		return fallback;
	}
	return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || fallback;
}

export function telegramMessageText(m) {
	if (m.text) return m.text;
	if (m.caption) return m.caption;
	if (m.photo) return '[photo]';
	if (m.sticker) return m.sticker.emoji ? `[sticker ${m.sticker.emoji}]` : '[sticker]';
	if (m.animation) return '[GIF]';
	if (m.video) return '[video]';
	if (m.video_note) return '[video message]';
	if (m.voice) return '[voice message]';
	if (m.audio) return '[audio]';
	if (m.document) return '[file]';
	if (m.poll) return '[poll]';
	if (m.location) return '[location]';
	return '[message]';
}

export function parseBridgeHeader(headerLine) {
	const line = (headerLine ?? '').trim().replace(/^\*+|\*+$/g, '');
	const match = /^(.*) \(([^()]*)\) \[Discord\]:?$/.exec(line);
	return match ? { name: match[1], account: match[2] } : null;
}

export function normalizeForMatch(text) {
	return (text ?? '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

export function looksLikeCopyOf(discordContent, copyBody) {
	const original = normalizeForMatch(discordContent);
	const copy = normalizeForMatch(copyBody);
	return original.length > 0 && copy.startsWith(original.slice(0, 40));
}

export function parseTelegramWebhookName(webhookName) {
	const withoutTag = (webhookName ?? '')
		.replace(/^\[TELEGRAM\] /, '')
		.replace(/ · Telegram.*$/, '');
	const match = /^(.*?)(?: \(@([A-Za-z0-9_]{3,32})\))?$/.exec(withoutTag);
	return { name: match?.[1] || withoutTag, username: match?.[2] };
}

export function protectUnderscores(text) {
	return text
		.replace(/https?:\/\/[^\s<>]+/g, (url) => url.replace(/_/g, '\\_'))
		.replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, '\\_');
}
