const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
} = require("discord.js");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Store user message counts and timeouts
const userMessages = new Map();

// Helper function to delete messages
async function deleteUserMessages(guild, userId, timeWindow) {
  try {
    const channels = await guild.channels.fetch();
    let deletedCount = 0;

    // Process channels in parallel for better performance
    await Promise.all(
      Array.from(channels.values()).map(async (channel) => {
        // Check if channel is a text channel and bot has permissions
        if (
          channel.type === ChannelType.GuildText &&
          channel.viewable &&
          channel.permissionsFor(client.user)?.has("ManageMessages")
        ) {
          try {
            let messagesDeleted;
            do {
              // Fetch messages in batches of 100
              const messages = await channel.messages
                .fetch({ limit: 100 })
                .catch(() => null);
              if (!messages) break;

              const userMessages = messages.filter(
                (msg) =>
                  msg.author.id === userId &&
                  msg.createdTimestamp > Date.now() - timeWindow
              );

              if (userMessages.size === 0) break;

              // Bulk delete messages if they're less than 14 days old
              if (
                userMessages.first()?.createdTimestamp >
                Date.now() - 14 * 24 * 60 * 60 * 1000
              ) {
                messagesDeleted = await channel
                  .bulkDelete(userMessages)
                  .catch(() => null);
                if (messagesDeleted) deletedCount += messagesDeleted.size;
              } else {
                // Delete messages one by one if they're older
                const deletedMessages = await Promise.allSettled(
                  userMessages.map((msg) => msg.delete())
                );
                deletedCount += deletedMessages.filter(
                  (result) => result.status === "fulfilled"
                ).length;
                messagesDeleted = userMessages;
              }
            } while (messagesDeleted?.size === 100); // Continue if we hit the fetch limit
          } catch (channelError) {
            console.error(
              `Error processing channel ${channel.id}:`,
              channelError
            );
            // Continue with other channels
          }
        }
      })
    );

    return deletedCount;
  } catch (error) {
    console.error("Error deleting messages:", error);
    return 0;
  }
}

// Function to safely send notification
async function sendNotification(channelId, content) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.permissionsFor(client.user)?.has("SendMessages")) {
      await channel.send(content);
    }
  } catch (error) {
    console.error("Error sending notification:", error);
  }
}

client.on(Events.MessageCreate, async (message) => {
  try {
    // Verify all required properties exist
    if (
      !message.guild ||
      !message.member ||
      !message.author ||
      !message.content
    ) {
      return;
    }

    // Ignore bot messages and messages from users with specific roles
    if (
      message.author.bot ||
      message.member.roles.cache.some((role) => process.env.EXEMPT_ROLE_IDS.split(',').includes(role.id))
    ) {
      return;
    }

    const userId = message.author.id;
    const messageContent = message.content;
    const ONE_HOUR = 3600 * 1000;

    // Initialize user data
    if (!userMessages.has(userId)) {
      userMessages.set(userId, {
        count: 0,
        lastMessage: null,
        timeout: null,
        messages: new Set(),
        channels: new Set(),
      });
    }

    const userData = userMessages.get(userId);

    // Check if the message is the same as the last message
    if (userData.lastMessage === messageContent) {
      userData.count += 1;
      userData.messages.add(message.id);
      userData.channels.add(message.channel.id);
    } else {
      userData.count = 1;
      userData.messages.clear();
      userData.channels.clear();
      userData.messages.add(message.id);
      userData.channels.add(message.channel.id);
    }

    userData.lastMessage = messageContent;

    // Check if the user has sent the same message 3 times
    if (userData.count >= 3) {
      try {
        // Check if member is still in guild and can be timed out
        if (message.member.manageable) {
          await message.member
            .timeout(ONE_HOUR, "Spamming the same message")
            .catch((error) => console.error("Error timing out member:", error));
        }

        // Delete all messages from the last hour
        const deletedCount = await deleteUserMessages(
          message.guild,
          userId,
          ONE_HOUR
        );

        // Create a user-friendly display of the spam message
        let displayMessage = messageContent;
        if (displayMessage.length > 1000) {
          displayMessage = displayMessage.slice(0, 997) + "...";
        }

        // Create a list of channels where spam occurred
        const channelMentions = Array.from(userData.channels)
          .map((channelId) => `<#${channelId}>`)
          .join(", ");

        // Send notification
        const notificationContent = [
          `User <@${userId}> has been timed out for spamming.`,
          `Channels affected: ${channelMentions}`,
          `Deleted ${deletedCount} messages from the last hour.`,
          "\nSpammed message:",
          "```",
          displayMessage,
          "```",
        ].join("\n");

        await sendNotification(
          process.env.TIMEOUT_CHANNEL_ID,
          notificationContent
        );
      } catch (error) {
        console.error("Error handling spam:", error);
      } finally {
        // Always clean up user data
        if (userData.timeout) {
          clearTimeout(userData.timeout);
        }
        userMessages.delete(userId);
      }
    } else {
      // Clean up user data after 1 hour if not blocked
      if (userData.timeout) {
        clearTimeout(userData.timeout);
      }
      userData.timeout = setTimeout(() => {
        userMessages.delete(userId);
      }, ONE_HOUR);
    }
  } catch (error) {
    console.error("Error processing message:", error);
  }
});

// Handle errors
client.on("error", (error) => {
  console.error("Client error:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

// Attempt to reconnect if disconnected
client.on("shardDisconnect", () => {
  console.log("Bot disconnected, attempting to reconnect...");
});

client.on("shardReconnecting", () => {
  console.log("Bot reconnecting...");
});

client.on("shardResume", () => {
  console.log("Bot reconnected successfully.");
});

// Login with error handling
client.login(process.env.BOT_TOKEN).catch((error) => {
  console.error("Failed to login:", error);
  process.exit(1);
});
