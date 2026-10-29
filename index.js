require("dotenv").config();

const ffmpegPath = require("ffmpeg-static");

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
} = require("discord.js");

const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
} = require("@discordjs/voice");

const play = require("play-dl");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Cada servidor tiene su propio reproductor y cola.
const music = new Map();

function getMusic(guildId) {
  if (!music.has(guildId)) {
    const state = {
      queue: [],
      current: null,
      advancing: false,
      player: createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        },
      }),
    };

    state.player.on(AudioPlayerStatus.Idle, () => {
      state.current = null;
      playNext(guildId).catch(console.error);
    });

    state.player.on("error", error => {
      console.error("Error de audio:", error.message);
    });

    music.set(guildId, state);
  }

  return music.get(guildId);
}

async function findSong(query) {
  const type = play.yt_validate(query);

  if (type === "video") {
    const info = await play.video_basic_info(query);
    const video = info.video_details;

    return {
      title: video.title,
      url: video.url,
      duration: video.durationRaw || "Desconocida",
    };
  }

  const results = await play.search(query, {
    limit: 1,
    source: { youtube: "video" },
  });

  if (!results.length) {
    throw new Error("No encontré esa canción.");
  }

  const video = results[0];

  return {
    title: video.title,
    url: video.url,
    duration: video.durationRaw || "Desconocida",
  };
}

async function playNext(guildId) {
  const state = music.get(guildId);

  if (!state || state.advancing) return;

  if (state.player.state.status !== AudioPlayerStatus.Idle) {
    return;
  }

  const song = state.queue.shift();

  if (!song) {
    state.current = null;
    return;
  }

  state.advancing = true;
  state.current = song;

  try {
    const stream = await play.stream(song.url, {
      discordPlayerCompatibility: true,
    });

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      metadata: { title: song.title },
    });

    state.player.play(resource);
    console.log(`🎵 Reproduciendo: ${song.title}`);
  } catch (error) {
    console.error(
      `No se pudo reproducir "${song.title}":`,
      error.message
    );

    state.current = null;
    state.advancing = false;

    setImmediate(() => {
      playNext(guildId).catch(console.error);
    });

    return;
  }

  state.advancing = false;
}

async function getVoiceChannel(interaction) {
  const member = await interaction.guild.members.fetch(
    interaction.user.id
  );

  return member.voice.channel;
}

async function connectToVoice(interaction, state) {
  const channel = await getVoiceChannel(interaction);

  if (!channel) {
    throw new Error("Primero entra a un canal de voz.");
  }

  const permissions = channel.permissionsFor(client.user);

  if (
    !permissions ||
    !permissions.has(["Connect", "Speak"])
  ) {
    throw new Error(
      "Necesito permisos para conectar y hablar en ese canal."
    );
  }

  let connection = getVoiceConnection(interaction.guildId);

  if (
    connection &&
    connection.joinConfig.channelId !== channel.id
  ) {
    connection.destroy();
    connection = undefined;
  }

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
  }

  await entersState(
    connection,
    VoiceConnectionStatus.Ready,
    20_000
  );

  connection.subscribe(state.player);

  return connection;
}

async function reply(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content });
  }

  return interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

client.once(Events.ClientReady, readyClient => {
  console.log(`✅ Conectado como ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.inGuild()) {
    return reply(interaction, "Usa el comando en un servidor.");
  }

  const state = getMusic(interaction.guildId);

  try {
    switch (interaction.commandName) {
      case "play": {
        await interaction.deferReply();

        const query = interaction.options.getString(
          "cancion",
          true
        );

        const channel = await getVoiceChannel(interaction);

        if (!channel) {
          return interaction.editReply(
            "❌ Primero entra a un canal de voz."
          );
        }

        const song = await findSong(query);

        await connectToVoice(interaction, state);

        const wasBusy =
          state.current !== null ||
          state.advancing ||
          state.player.state.status !== AudioPlayerStatus.Idle;

        state.queue.push(song);

        if (!wasBusy) {
          await playNext(interaction.guildId);
        }

        return interaction.editReply(
          `🎵 **${song.title}**\n` +
          `⏱️ Duración: ${song.duration}\n` +
          (wasBusy
            ? "📥 Añadida a la cola."
            : "▶️ Preparando la reproducción.")
        );
      }

      case "pause": {
        if (state.player.pause()) {
          return reply(interaction, "⏸️ Música pausada.");
        }

        return reply(interaction, "No hay música que pausar.");
      }

      case "resume": {
        if (state.player.unpause()) {
          return reply(interaction, "▶️ Música reanudada.");
        }

        return reply(interaction, "No hay música pausada.");
      }

      case "skip": {
        if (
          !state.current ||
          state.player.state.status === AudioPlayerStatus.Idle
        ) {
          return reply(interaction, "No hay canción para saltar.");
        }

        state.player.stop(true);

        return reply(interaction, "⏭️ Canción saltada.");
      }

      case "stop": {
        state.queue.length = 0;
        state.current = null;
        state.player.stop(true);

        return reply(
          interaction,
          "⏹️ Música detenida y cola vaciada."
        );
      }

      case "queue": {
        const lines = [];

        if (state.current) {
          lines.push(`▶️ **Sonando:** ${state.current.title}`);
        }

        if (state.queue.length > 0) {
          lines.push(
            "",
            "**📜 Próximas canciones:**",
            ...state.queue.slice(0, 10).map(
              (song, index) =>
                `**${index + 1}.** ${song.title}`
            )
          );

          if (state.queue.length > 10) {
            lines.push(
              `...y ${state.queue.length - 10} más.`
            );
          }
        }

        if (!lines.length) {
          return reply(interaction, "📭 La cola está vacía.");
        }

        return reply(interaction, lines.join("\n"));
      }

      case "leave": {
        state.queue.length = 0;
        state.current = null;
        state.player.stop(true);

        const connection = getVoiceConnection(
          interaction.guildId
        );

        if (connection) {
          connection.destroy();
        }

        music.delete(interaction.guildId);

        return reply(
          interaction,
          "👋 Me desconecté y limpié la cola."
        );
      }
    }
  } catch (error) {
    console.error("Error en comando:", error);

    const message = error.message === "No encontré esa canción."
      ? error.message
      : error.message === "Primero entra a un canal de voz."
        ? error.message
        : error.message.startsWith("Necesito permisos")
          ? error.message
          : "❌ Hubo un error. Revisa la terminal de VS Code.";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await reply(interaction, message).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error(
    "❌ No se pudo iniciar sesión. Revisa el token de .env.",
    error.message
  );
});
