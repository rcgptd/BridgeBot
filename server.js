#!/usr/bin/env node
import { discordClient, discordWebhookClient } from './backends/discord.js';
import { bot, telegram, telegramGetFileURL, telegramGetProfilePic } from './backends/telegram.js';

import { enable_heroku } from './utils/heroku.js';
import { sendDiscordToTelegram } from './utils/forward.js';
import {
	BoundedMap, hiddenDiscordLink, findDiscordLink, makeQuote, escapeDiscordMd, escapeTelegramMd,
	snippet, telegramDisplayName, telegramMessageText, parseBridgeHeader, looksLikeCopyOf, parseTelegramWebhookName, protectUnderscores
} from './utils/replies.js';
import { MessageType } from 'discord.js';

if ("HEROKU_DYNO_URL" in process.env) {
	enable_heroku();
}

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const DISCORD_FORWARD_BOT = (process.env.DISCORD_FORWARD_BOT === 'true')

const MAX_MESSAGE_AGE_MS = 10 * 1000;

//console.log("Telegram chat id: " + TELEGRAM_CHAT_ID);
//console.log("Discord channel id: " + DISCORD_CHANNEL_ID);

//5000 message IDs
const discordToTelegram = new BoundedMap(5000); // Discord message id -> Telegram message id
const telegramToDiscord = new BoundedMap(5000); // Telegram message id -> Discord (webhook) message id

let telegramBotId;
telegram.getMe()
	.then((me) => { telegramBotId = me.id; })
	.catch((err) => console.log("Could not get Telegram bot id, reply links disabled: " + err.message));

const discordGuildId = () => discordClient.channels.cache.get(DISCORD_CHANNEL_ID)?.guildId;


discordClient.on("messageCreate", async message => {

	if (message.channel.id !== DISCORD_CHANNEL_ID || (message.author.bot && !DISCORD_FORWARD_BOT)) {
		return;
	}

	if (Date.now() - message.createdTimestamp > MAX_MESSAGE_AGE_MS) {
		return;
	}

	let replyTo;
	let replyNote = '';
	if (message.type === MessageType.Reply && message.reference?.messageId) {
		replyTo = discordToTelegram.get(message.reference.messageId);
		if (!replyTo) {
			const ref = await message.fetchReference().catch(() => null);
			if (ref) {
				const { name: refName, username: refUsername } = parseTelegramWebhookName(
					ref.webhookId ? ref.author.username : (ref.member?.displayName ?? ref.author.globalName ?? ref.author.username));
				const refText = ref.content || (ref.attachments.size ? '[attachment]' : '[message]');
				const who = refUsername ? `@${escapeTelegramMd(refUsername)}` : `_${escapeTelegramMd(refName)}_`;
				replyNote = `↪ ${who}: ${escapeTelegramMd(snippet(refText))}\n`;
				console.log("Reply target not in memory, using " + (refUsername ? "@username mention" : "name") + " instead of a native reply");
			}
		}
	}

	const repliedUserId = message.mentions.repliedUser?.id;
	let mentioned_usernames = []
	for (let mention of message.mentions.users) {
		if (mention[0] === repliedUserId && !message.content.includes(`<@${repliedUserId}>`)
			&& !message.content.includes(`<@!${repliedUserId}>`)) {
			continue;
		}
		mentioned_usernames.push("@" + mention[1].username);
	}

	var imageUrls = []
	var videoUrls = []
	var gifUrls = []
	var attachmentUrls = []
	for (let attachment of message.attachments.values()) {
		const type = attachment.contentType ?? "";
		if (type === "image/gif") {
			gifUrls.push(attachment.url);
		} else if (type.startsWith("image/")) {
			imageUrls.push(attachment.url);
		} else if (type.startsWith("video/")) {
			videoUrls.push(attachment.url);
		} else {
			attachmentUrls.push(attachment.url);
		}
	}

	var finalMessageContent = message.content.replace(/<@.*>/gi, '');
	finalMessageContent = finalMessageContent.replace(/\*\*/g, '*');

	const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
	const escapeMd = (str) => str.replace(/([_*`\[])/g, '\\$1');
	var text = `*${escapeMd(displayName)} (${escapeMd(message.author.username)}) [Discord]:*`
		+ hiddenDiscordLink(message.guildId, message.channelId, message.id) + `\n`;
	text += replyNote;
	text += protectUnderscores(finalMessageContent)
	if (attachmentUrls.length > 0) {
		text += ` ${attachmentUrls.join(' ')}`;
	}
	text += mentioned_usernames.join(" ");

	const previewUrl = /https?:\/\/[^\s<>]+/.exec(finalMessageContent + ' ' + attachmentUrls.join(' '))?.[0];

	try {
		const telegramId = await sendDiscordToTelegram(telegram, TELEGRAM_CHAT_ID, text, imageUrls, { replyTo, previewUrl, videoUrls, gifUrls });
		if (telegramId) {
			discordToTelegram.set(message.id, telegramId);
		}
	}
	catch(err) {
		console.log(err.message);
	}
});

async function buildDiscordReply(message, reply) {
	const quoted = message.quote?.text; 
	const fromBridgeBot = telegramBotId !== undefined && reply.from?.id === telegramBotId;
	const link = fromBridgeBot ? findDiscordLink(reply) : null;
	if (link && link.channelId === DISCORD_CHANNEL_ID) {
		const url = `https://discord.com/channels/${link.guildId}/${link.channelId}/${link.messageId}`;
		let ref = null;
		try {
			const channel = await discordClient.channels.fetch(link.channelId);
			ref = await channel.messages.fetch(link.messageId);
		} catch (err) {
			console.log("Could not fetch replied-to Discord message: " + err.message);
		}
		if (ref) {
			let body = quoted ?? ref.content;
			if (!body) {
				const attachment = ref.attachments.first();
				body = attachment
					? (attachment.contentType?.startsWith('image/') ? '[image]' : '[attachment]')
					: (ref.embeds.length ? '[embed]' : '[message]');
			}
			return {
				header: `↪ <@${ref.author.id}> · [original message](${url})\n${makeQuote(body)}`,
				pingId: ref.author.id,
			};
		}
		const copy = reply.text ?? reply.caption ?? '';
		return { header: `↪ [original message](${url})\n${makeQuote(quoted ?? copy.slice(copy.indexOf('\n') + 1))}` };
	}

	if (fromBridgeBot) {
		const copy = reply.text ?? reply.caption ?? '';
		const newline = copy.indexOf('\n');
		const headerLine = newline >= 0 ? copy.slice(0, newline) : copy;
		const copyBody = newline >= 0 ? copy.slice(newline + 1) : '';
		const parsed = parseBridgeHeader(headerLine);
		const name = parsed?.name ?? headerLine.replace(/^\*+|\*+$/g, '').replace(/ \[Discord\]:?$/, '');
		const body = quoted ?? copyBody;
		console.log("Reply: no Discord link found in the replied-to Telegram message, searching recent messages");

		let match = null, authorId = null;
		if (parsed) {
			try {
				const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
				const recent = await channel.messages.fetch({ limit: 100 }); // newest first
				const theirs = [...recent.values()].filter((m) => !m.webhookId && m.author.username === parsed.account);
				match = theirs.find((m) => looksLikeCopyOf(m.content, copyBody)) ?? null;
				authorId = (match ?? theirs[0])?.author.id ?? null;
			} catch (err) {
				console.log("Could not search recent Discord messages: " + err.message);
			}
		}
		const who = authorId ? `<@${authorId}>` : `**${escapeDiscordMd(name)}**`;
		const url = match ? ` · [original message](https://discord.com/channels/${match.guildId ?? discordGuildId()}/${DISCORD_CHANNEL_ID}/${match.id})` : '';
		return {
			header: `↪ ${who}${url}\n${makeQuote(body || '[message]')}`,
			pingId: authorId ?? undefined,
		};
	}

	const name = reply.from ? telegramDisplayName(reply.from) : (reply.sender_chat?.title ?? 'someone');
	const discordId = telegramToDiscord.get(reply.message_id);
	const guildId = discordGuildId();
	const url = (discordId && guildId) ? `https://discord.com/channels/${guildId}/${DISCORD_CHANNEL_ID}/${discordId}` : null;
	return {
		header: `↪ **${escapeDiscordMd(name)}**${url ? ` · [original message](${url})` : ''}\n${makeQuote(quoted ?? telegramMessageText(reply))}`,
	};
}

bot.on("message", async (ctx) => {
	const message = ctx.message;
	if (!message) {
		return;
	}

	// console.log(message)
	if (message.chat.id != TELEGRAM_CHAT_ID) {
		return;
	}

	if (Date.now() - message.date * 1000 > MAX_MESSAGE_AGE_MS) {
		return;
	}

	if (message.from.is_bot) {
		return;
	}

	const sourceLabel = message.chat.username ? `@${message.chat.username}` : (message.chat.title ?? '');

	var userPart = message.from.first_name;
	if (message.from.last_name) {
		userPart += ` ${message.from.last_name}`;
	}
	if (message.from.username) {
		userPart += ` (@${message.from.username})`;
	}
	const nameSuffix = ` · Telegram${sourceLabel ? ' ' + sourceLabel : ''}`;
	if (userPart.length + nameSuffix.length > 80) {
		userPart = userPart.slice(0, Math.max(1, 79 - nameSuffix.length)) + '…';
	}
	var username = userPart + nameSuffix;

	let profileUrl = await telegramGetProfilePic(message);

	var text;
	var fileId;

	const hasMedia = message.document || message.photo || message.sticker || message.video
		|| message.animation || message.video_note || message.voice || message.audio;
	if (!hasMedia) {
		if (!message.text) {
			return;
		}
		text = message.text;

		if (message.entities) {
			text = convert_text_telegram_to_discord(text, message.entities);
		}

	} else {
		text = message.caption;

		if (message.caption_entities) {
			text = convert_text_telegram_to_discord(text, message.caption_entities);
		}

		if (message.document) {
			fileId = message.document.file_id;
		} else if (message.sticker) {
			fileId = message.sticker.file_id;
		} else if (message.photo) {
			fileId = message.photo[message.photo.length - 1].file_id;
		} else if (message.video) {
			fileId = message.video.file_id;
		} else if (message.animation) {
			fileId = message.animation.file_id;
		} else if (message.video_note) {
			fileId = message.video_note.file_id;
		} else if (message.voice) {
			fileId = message.voice.file_id;
		} else if (message.audio) {
			fileId = message.audio.file_id;
		}
	}

	if (text) {
		text = text.replace(/@everyone/g, "[EVERYONE]").replace(/@here/g, "[HERE]");
	}

	let allowedMentions = { parse: [] };
	const reply = message.reply_to_message;
	if (reply && !reply.forum_topic_created) {
		try {
			const built = await buildDiscordReply(message, reply);
			text = built.header + (text ? '\n' + text : '');
			if (built.pingId) {
				allowedMentions = { users: [built.pingId] };
			}
		}
		catch(err) {
			console.log("Could not build reply header: " + err.message);
		}
	}
	//max 20MB filesize
	var fileUrl = "";
	if (fileId) {
		try {
			var file = await telegram.getFile({ file_id: fileId });
			fileUrl = telegramGetFileURL(file.file_path);
		} catch (err) {
			console.log("Could not get Telegram file: " + err.message);
			text = (text ? text + '\n' : '') + '[file too large to forward]';
		}
	}

	const subtext = sourceLabel ? `\n-# Forwarded from ${escapeDiscordMd(sourceLabel)}` : '';

	const maxBody = 2000 - subtext.length;
	if (text && text.length > maxBody) {
		text = text.slice(0, maxBody - 1) + '…';
	}
	text = text ? text + subtext : subtext.replace(/^\n/, '');

	try {
		const payload = { content: text, username: username, avatarURL: profileUrl, allowedMentions: allowedMentions };
		if (fileUrl != "") {
			payload.files = [fileUrl];
		}
		let discordMessage;
		try {
			discordMessage = await discordWebhookClient.send(payload);
		} catch (err) {
			if (!payload.files) {
				throw err;
			}
			console.log("Discord rejected the file, sending text only: " + err.message);
			delete payload.files;
			payload.content = (text ? text.replace(/\n-# Forwarded from[^\n]*$/, '') + '\n' : '') + '[file too large for Discord]' + subtext;
			discordMessage = await discordWebhookClient.send(payload);
		}
		if (discordMessage?.id) {
			telegramToDiscord.set(message.message_id, discordMessage.id);
			discordToTelegram.set(discordMessage.id, message.message_id);
		}
	}
	catch(err) {
		console.log(err.message);
		return;
	}
});

function convert_text_telegram_to_discord(text, entities) {
	var convert;
	var start_format;
	var end_format;
	var section_offset = 0
	var section_end;
	var section_start;

	entities.forEach(({type, offset, length, url}) => {
		convert = true;
		if (type == 'bold') {
			start_format = '\*\*';
			end_format = '\*\*';
		} else if(type == 'italic') {
			start_format = '\_';
			end_format = '\_';
		} else if(type == 'text_link') {
			start_format = '\*\*';
			end_format = '\*\* (<' + url + '>)';
		} else {
			convert = false;
		}

		if (convert) {
			section_start = offset + section_offset;
			section_end = offset + length + section_offset;
			text = text.slice(0, section_end) + end_format + text.slice(section_end);
			text = text.slice(0, section_start) + start_format + text.slice(section_start);
			section_offset += start_format.length + end_format.length;
		}
	});

	return text
}

bot.startPolling(undefined, {
	onError: (err) => console.log("Telegram polling error: " + (err?.message ?? err)),
}).catch((err) => {
	console.log("Telegram polling stopped: " + err);
	process.exit(1);
});
console.log("Telegram polling started");
