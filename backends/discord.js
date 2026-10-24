import { Client, GatewayIntentBits, WebhookClient } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_WEBHOOK_ID = process.env.DISCORD_WEBHOOK_ID;
const DISCORD_WEBHOOK_TOKEN = process.env.DISCORD_WEBHOOK_TOKEN;


export const discordClient = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

export const discordWebhookClient = new WebhookClient({
	id: DISCORD_WEBHOOK_ID,
	token: DISCORD_WEBHOOK_TOKEN,
});

discordClient.once("clientReady", () => {
	console.log("Discord bot ready!");
});

discordClient.login(DISCORD_TOKEN);
