/**
 * A RESERVA DA API — o que mantém os overlays desenhados sem a casa.
 *
 * O bot mora na casa do britto; o OBS, na do Kennzy. Uma queda de luz ou de
 * internet lá derruba `api.brittico.xyz` no meio de uma live que continua no
 * ar — e a fonte do OBS não é uma aba que alguém conserta com F5.
 *
 * O que este Worker faz, e o que ele explicitamente NÃO faz:
 *
 *   SERVE DO SNAPSHOT   o documento do overlay, a mídia (abertura inclusa),
 *                       a fita de eventos, os emotes, as partidas e o elo
 *   CALCULA AO VIVO     quantos estão assistindo, e o que está tocando —
 *                       as duas coisas que ficam ERRADAS se congelarem
 *   NÃO FAZ             alertas, chat, comandos, moderação, escrita
 *
 * A divisão não é de esforço, é de natureza: o que ele calcula ao vivo é
 * exatamente o que sai de credencial de APP ou chave de API, sem banco e sem
 * conta autorizada. O resto precisaria do bot, e um segundo bot no chat
 * responderia duas vezes.
 *
 * NENHUMA ROTA AQUI ESCREVE NADA. Se um dia alguém for tentado a aceitar um
 * POST, lembre que este arquivo não tem sessão, não tem moderador e responde
 * na internet aberta.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/* Quanto tempo o navegador pode guardar cada tipo de resposta. Curto: isto
   está no ar justamente durante um problema, e o que se quer é que a volta
   do primário apareça rápido. A mídia é a exceção — nome imutável. */
const TTL = { snapshot: 30, vivo: 15, midia: 2592000 };

function cors(env, req) {
  const permitidas = String(env.SITE_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const origem = req.headers.get("Origin") || "";
  /* Ecoa a origem quando ela está na lista, em vez de responder "*": o site
     manda `credentials` em algumas chamadas, e o curinga e recusado pelo
     navegador nesse caso. Fora da lista, sem cabeçalho — o fetch falha, que
     é a resposta certa para uma página que não é a nossa. */
  return permitidas.includes(origem) ? { "access-control-allow-origin": origem, "vary": "Origin" } : {};
}

function json(dados, env, req, ttl) {
  return new Response(JSON.stringify(dados), {
    headers: { ...JSON_HEADERS, "cache-control": `public, max-age=${ttl}`, ...cors(env, req) }
  });
}

function erro(status, msg, env, req) {
  return new Response(JSON.stringify({ error: msg, reserva: true }), {
    status, headers: { ...JSON_HEADERS, ...cors(env, req) }
  });
}

/** Lê um JSON do snapshot. `null` quando nunca foi sincronizado. */
async function snap(env, chave) {
  const o = await env.RESERVA.get(`snap/${chave}.json`);
  if (!o) return null;
  try { return await o.json(); } catch { return null; }
}

/* ==========================================================================
   AO VIVO — as duas coisas que não podem congelar
   ========================================================================== */

/**
 * Quantos estão assistindo, nas três plataformas.
 *
 * Traduzido de services/viewers.ts do bot, e A FORMA DA RESPOSTA É CONTRATO:
 * o widget do overlay lê `total`, `live` e `platforms[]`. Se aquele arquivo
 * mudar de formato, este muda junto — ou o widget quebra só durante uma
 * queda, que é o pior momento possível para descobrir.
 *
 * Como lá, as três são buscadas em paralelo e uma falha não derruba as
 * outras. O que NÃO foi copiado é o cache de "última leitura boa" por
 * plataforma: ele existe para que um tropeço de rede não faça o total
 * despencar por cima da live, e depende de memória entre chamadas que um
 * Worker não tem. O `cache-control` de 15 s cobre parte disso, e pior —
 * mas isto é a reserva, não o titular.
 */
async function viewers(env) {
  const fora = (id, note = "") => ({ id, live: false, viewers: null, title: "", note, at: Date.now() });

  const twitch = async () => {
    const login = String(env.TWITCH_CHANNEL || "").replace(/^#/, "").toLowerCase();
    if (!login || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return fora("twitch", "Twitch: sem credencial na reserva.");
    const t = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET,
        grant_type: "client_credentials"
      })
    }).then(r => r.json());
    if (!t || !t.access_token) return fora("twitch", "Twitch: token de app recusado.");

    const d = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`, {
      headers: { Authorization: `Bearer ${t.access_token}`, "Client-Id": env.TWITCH_CLIENT_ID }
    }).then(r => r.json());

    const s = ((d && d.data) || [])[0];
    if (!s || s.type !== "live") return fora("twitch");
    return { id: "twitch", live: true, viewers: Number(s.viewer_count) || 0, title: String(s.title || ""), note: "", at: Date.now() };
  };

  const kick = async () => {
    const canal = String(env.KICK_CHANNEL || "");
    if (!canal) return fora("kick", "Kick: sem KICK_CHANNEL na reserva.");
    /* A v2 pública, e não a v1 com client_credentials: ela não precisa de
       segredo nenhum e é a mesma que o bot usa de reserva. Se a Kick fechá-la,
       o widget mostra as outras duas — que é o comportamento de lá também. */
    const d = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(canal)}`, {
      headers: { accept: "application/json" }
    }).then(r => r.ok ? r.json() : null);
    const s = d && d.livestream;
    if (!s || !s.is_live) return fora("kick");
    return { id: "kick", live: true, viewers: Number(s.viewer_count) || 0, title: String(s.session_title || ""), note: "", at: Date.now() };
  };

  const youtube = async () => {
    if (!env.YOUTUBE_API_KEY || !env.YOUTUBE_CHANNEL_ID) return fora("youtube", "YouTube: sem chave na reserva.");
    /* A MESMA economia de cota do bot: playlistItems + videos, 2 unidades.
       `search.list` custa 100 e já esgotou o dia deles duas vezes — está
       escrito em services/viewers.ts, e não vale repetir o erro aqui. */
    const uploads = "UU" + String(env.YOUTUBE_CHANNEL_ID).slice(2);
    const pl = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=10&playlistId=${uploads}&key=${env.YOUTUBE_API_KEY}`).then(r => r.json());
    const ids = ((pl && pl.items) || []).map(i => i && i.contentDetails && i.contentDetails.videoId).filter(Boolean);
    if (!ids.length) return fora("youtube");

    const vs = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${ids.join(",")}&key=${env.YOUTUBE_API_KEY}`).then(r => r.json());
    const v = ((vs && vs.items) || []).find(i => i && i.snippet && i.snippet.liveBroadcastContent === "live");
    if (!v) return fora("youtube");

    const n = v.liveStreamingDetails && v.liveStreamingDetails.concurrentViewers;
    return {
      id: "youtube", live: true,
      /* null e não 0: o dono pode esconder a contagem, e a transmissão existe
         sem ela. Um zero diria "ninguém está assistindo", que é outra coisa. */
      viewers: n == null ? null : Number(n),
      title: String((v.snippet && v.snippet.title) || ""),
      note: n == null ? "YouTube: a contagem está oculta." : "",
      at: Date.now()
    };
  };

  const r = await Promise.allSettled([twitch(), kick(), youtube()]);
  const nomes = ["twitch", "kick", "youtube"];
  const platforms = r.map((x, i) => x.status === "fulfilled" ? x.value : fora(nomes[i], "Não deu para ler agora."));
  const live = platforms.some(p => p.live);
  const total = platforms.reduce((s, p) => s + (p.viewers || 0), 0);
  return { total, live, platforms, fetchedAt: Date.now() };
}

/**
 * O que está tocando — direto no Last.fm.
 *
 * Traduzido de services/lastfm.ts. As três coisas que precisam bater com lá,
 * porque o widget e a página /musica/ leem o mesmo formato:
 *
 *   `key`        artista e faixa normalizados, separados por \u0001
 *   `playedAt`   0 na que está tocando AGORA (ela ainda não terminou, então
 *                não tem hora de execução — é isso que a distingue)
 *   `image`      null quando é a estrela cinza do "sem capa" deles, que vem
 *                com HTTP 200 e encheria a tela de estrelas idênticas
 *
 * O separador vai escrito como escape de propósito, exatamente como no bot: o
 * caractere literal é invisível no arquivo, e apagá-lo sem querer mudaria
 * TODAS as chaves sem deixar rastro no diff.
 */
async function musicaAgora(env) {
  const vazio = { track: null, live: false, checkedAt: Math.floor(Date.now() / 1000) };
  if (!env.LASTFM_API_KEY || !env.LASTFM_USER) return vazio;

  const d = await fetch(
    `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(env.LASTFM_USER)}&api_key=${env.LASTFM_API_KEY}&format=json&limit=1`
  ).then(r => r.ok ? r.json() : null);

  const raw = ((d && d.recenttracks && d.recenttracks.track) || [])[0];
  if (!raw) return vazio;

  const norm = s => String(s).toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();
  const pickImage = imgs => {
    if (!Array.isArray(imgs)) return null;
    for (const size of ["extralarge", "large", "medium", "small"]) {
      const achou = imgs.find(i => i && i.size === size && i["#text"]);
      const u = achou && achou["#text"];
      if (u && !u.includes("2a96cbd8b46e442fc41c2b86b821562f")) return u;
    }
    return null;
  };

  const artist = (raw.artist && (raw.artist["#text"] || raw.artist.name)) || "";
  const track = raw.name || "";
  if (!artist || !track) return vazio;

  const nowPlaying = !!(raw["@attr"] && raw["@attr"].nowplaying === "true");
  return {
    track: {
      key: norm(artist) + "\u0001" + norm(track),
      artist, track,
      album: (raw.album && raw.album["#text"]) || null,
      image: pickImage(raw.image),
      url: raw.url || null,
      playedAt: raw.date && raw.date.uts ? Number(raw.date.uts) : 0,
      nowPlaying
    },
    live: nowPlaying,
    checkedAt: Math.floor(Date.now() / 1000)
  };
}

/* ==========================================================================
   O SSE MUDO
   ==========================================================================
   O EventSource religa a cada 3 s, para sempre, e não sabe desistir. Deixar
   estas rotas em 404 seria uma fonte do OBS batendo ~1.200 vezes por hora
   durante toda a queda — barulho na cota e no log, para nada.

   Uma conexão aberta que só manda comentário de vida custa quase zero e
   deixa o navegador quieto. Ela nunca entrega evento nenhum, o que é
   honesto: não há bot para produzi-los. */
function sseMudo(env, req) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      /* `retry` longo: se esta conexão cair, a próxima tentativa não precisa
         ser em 3 s — não há nada mudando do outro lado. */
      c.enqueue(enc.encode("retry: 30000\n: reserva, sem eventos\n\n"));
    },
    pull(c) {
      return new Promise(r => setTimeout(() => { c.enqueue(enc.encode(": ok\n\n")); r(); }, 25000));
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      ...cors(env, req)
    }
  });
}

/* ========================================================================== */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: { ...cors(env, req), "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type" }
      });
    }
    /* Só leitura. Ver o aviso no topo do arquivo. */
    if (req.method !== "GET" && req.method !== "HEAD") return erro(405, "A reserva só responde GET.", env, req);

    try {
      /* --- a mídia: a abertura, os vídeos, os sons ---------------------- */
      if (p.startsWith("/api/overlays/media/file/")) {
        const nome = p.slice("/api/overlays/media/file/".length);
        /* O nome é gerado por crypto.randomBytes(12) no bot: 24 hex e uma
           extensão, nada mais. A checagem existe para que um ".." não vire
           uma chave do bucket. */
        if (!/^[a-f0-9]{24}\.[a-z0-9]{2,5}$/.test(nome)) return erro(400, "Nome de arquivo inválido.", env, req);
        const obj = await env.RESERVA.get("media/" + nome);
        if (!obj) return erro(404, "Esse arquivo não está na reserva.", env, req);
        return new Response(obj.body, {
          headers: {
            "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream",
            /* immutable como no bot: o nome nunca é reescrito, um upload novo
               é um id novo. Sem isto, um vídeo de 20 mb seria rebaixado a cada
               troca de cena que reinicia a fonte. */
            "cache-control": `public, max-age=${TTL.midia}, immutable`,
            ...cors(env, req)
          }
        });
      }

      /* --- ao vivo ------------------------------------------------------ */
      if (p === "/api/live/viewers") return json(await viewers(env), env, req, TTL.vivo);
      if (p === "/api/music/now")    return json(await musicaAgora(env), env, req, TTL.vivo);

      /* --- os canos de evento, mudos ------------------------------------ */
      if (p === "/api/events/music" || /^\/api\/overlays\/[^/]+\/events$/.test(p)) return sseMudo(env, req);

      /* --- do snapshot -------------------------------------------------- */
      if (p === "/api/emotes")              return json((await snap(env, "emotes")) || { emotes: [] }, env, req, TTL.snapshot);
      if (p === "/api/lol/lp")              return json((await snap(env, "lol-lp")) || {}, env, req, TTL.snapshot);
      if (p.startsWith("/api/lol/matches")) return json((await snap(env, "lol-matches")) || { matches: [], total: 0 }, env, req, TTL.snapshot);

      /* A fita. Vem ANTES da leitura do documento porque `/eventos` é um
         sufixo do mesmo caminho — na ordem inversa o `:publicId` engoliria,
         que é a mesma armadilha comentada em setupOverlaysRoutes no bot. */
      let m = p.match(/^\/api\/overlays\/([^/]+)\/eventos$/);
      if (m) return json((await snap(env, "eventos-" + m[1])) || { events: [] }, env, req, TTL.snapshot);

      m = p.match(/^\/api\/overlays\/([^/]+)$/);
      if (m) {
        const d = await snap(env, "overlay-" + m[1]);
        /* 404 e não um documento vazio: um overlay em branco no ar parece um
           defeito do overlay. O 404 faz a página mostrar o motivo — e, na
           partida a frio, o KzCache dela já pintou a última cópia boa. */
        if (!d) return erro(404, "Esse overlay não está na reserva.", env, req);
        return json(d, env, req, TTL.snapshot);
      }

      return erro(503, "A reserva não serve esta rota. O bot está fora do ar.", env, req);
    } catch (e) {
      /* Um erro aqui é a reserva falhando durante uma queda do primário, que
         é o pior encadeamento possível — então ele fica no log com o caminho. */
      console.error("[reserva]", p, (e && e.message) || e);
      return erro(502, "A reserva falhou ao montar a resposta.", env, req);
    }
  }
};
