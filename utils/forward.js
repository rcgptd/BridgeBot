const CAPTION_LIMIT = 1024;
const ALBUM_LIMIT = 10;
const HIDDEN_LINK_RE = /\[\u200B\]\([^)]*\)/g;

const isParseError = (err) => /can't parse entities/i.test(err?.message ?? '');

function safeMarkdown(text) {
	const newline = text.indexOf('\n');
	if (newline < 0) {
		return text;
	}
	const header = text.slice(0, newline);
	const rest = text.slice(newline + 1)
		.replace(/\\([_*`\[])/g, '$1')      // undo escapes already there, to avoid doubling them
		.replace(/([_*`\[])/g, '\\$1');
	return header + '\n' + rest;
}

export async function sendDiscordToTelegram(telegram, chatId, text, imageUrls, options = {}) {
	const { replyTo, previewUrl } = options;
	let firstId;
	let replyPending = Boolean(replyTo);

	const sent = (result) => {
		if (firstId === undefined) {
			firstId = (Array.isArray(result) ? result[0] : result)?.message_id;
		}
		replyPending = false;
		return result;
	};
	const replyParams = () => replyPending
		? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
		: {};

	const sendText = async (body) => {
		const params = {
			chat_id: chatId,
			text: body,
			link_preview_options: previewUrl ? { url: previewUrl } : { is_disabled: true },
			...replyParams(),
		};
		try {
			return sent(await telegram.sendMessage({ ...params, parse_mode: 'Markdown' }));
		} catch (err) {
			if (!isParseError(err)) {
				throw err;
			}
			console.log("Markdown rejected by Telegram, resending with the body escaped: " + err.message);
			try {
				return sent(await telegram.sendMessage({ ...params, text: safeMarkdown(body), parse_mode: 'Markdown' }));
			} catch (err2) {
				if (!isParseError(err2)) {
					throw err2;
				}
				console.log("Still rejected, sending as plain text: " + err2.message);
				return sent(await telegram.sendMessage({ ...params, text: body.replace(HIDDEN_LINK_RE, '') }));
			}
		}
	};

	const videoUrls = options.videoUrls ?? [];
	const gifUrls = options.gifUrls ?? [];
	if (imageUrls.length === 0 && videoUrls.length === 0 && gifUrls.length === 0) {
		await sendText(text);
		return firstId;
	}

	const items = [
		...imageUrls.map((url) => ({ kind: 'photo', url })),
		...videoUrls.map((url) => ({ kind: 'video', url })),
		...gifUrls.map((url) => ({ kind: 'animation', url })),
	];
	const useCaption = text.length <= CAPTION_LIMIT;
	let captionPending = useCaption;
	let textDelivered = false;
	const takeCaption = () => {
		if (!captionPending) return {};
		captionPending = false;
		return { caption: text, parse_mode: 'Markdown' };
	};
	const withCaption = async (captionHere, send) => {
		try {
			return await send(captionHere);
		} catch (err) {
			if (!captionHere.caption || !isParseError(err)) {
				throw err;
			}
			console.log("Caption rejected by Telegram, resending with the body escaped: " + err.message);
			return await send({ ...captionHere, caption: safeMarkdown(captionHere.caption) });
		}
	};
	let done = 0;
	try {
		if (!useCaption) {
			await sendText(text);
			textDelivered = true;
		}
		while (done < items.length) {
			const kind = items[done].kind;
			if (kind === 'photo') {
				let end = done;
				while (end < items.length && items[end].kind === 'photo' && end - done < ALBUM_LIMIT) end++;
				const chunk = items.slice(done, end);
				const captionHere = takeCaption();
				if (chunk.length === 1) {
					sent(await withCaption(captionHere, (cap) =>
						telegram.sendPhoto({ chat_id: chatId, photo: chunk[0].url, ...cap, ...replyParams() })));
				} else {
					sent(await withCaption(captionHere, (cap) => telegram.sendMediaGroup({
						chat_id: chatId,
						media: chunk.map((item, j) => ({ type: 'photo', media: item.url, ...(j === 0 ? cap : {}) })),
						...replyParams(),
					})));
				}
				if (captionHere.caption) textDelivered = true;
				done = end;
			} else {
				const captionHere = takeCaption();
				const method = kind === 'video' ? 'sendVideo' : 'sendAnimation';
				sent(await withCaption(captionHere, (cap) =>
				telegram[method]({ chat_id: chatId, [kind]: items[done].url, ...cap, ...replyParams() })));
				if (captionHere.caption) textDelivered = true;
				done++;
			}
		}
	} catch (err) {
		console.log("Sending media failed, falling back to links: " + err.message);
		const rest = items.slice(done).map((item) => item.url).join('\n');
		await sendText((textDelivered ? '' : text + '\n') + rest);
	}
	return firstId;
}
