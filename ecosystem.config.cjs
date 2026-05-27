module.exports = {
	apps: [
		{
			name: "pi-bot",
			script: "channel.ts",
			interpreter: "node",
			autorestart: true,
			restart_delay: 1000,
			time: true,
			watch: false,
		},
	],
};
