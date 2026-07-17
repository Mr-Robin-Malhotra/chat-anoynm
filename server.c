/*
 * chat-anoynm relay server
 * ------------------------
 * A blind WebSocket relay written in C. It forwards messages between the
 * people in a room and does nothing else. On purpose it:
 *   - keeps rooms in memory only, wiped the moment a client leaves
 *   - writes NO logs, NO files, NO database
 *   - never sees message contents (they're encrypted in the browser before
 *     they ever reach here, so all this code moves around is ciphertext)
 *
 * The crypto lives in the browser (WebCrypto), not here. That's deliberate:
 * you don't hand-roll crypto in C. The server's only job is to be a fast,
 * forgetful pipe.
 *
 * Security note: every frame length is validated against the bytes actually
 * received before any indexing, so a malformed/short frame can't overrun the
 * buffer. Frames larger than one read are rejected rather than mis-parsed.
 *
 * Build:  cc -O2 -Wall -o server server.c
 * Run:    ./server 8080
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <time.h>
#include <poll.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>

#define MAX_CLIENTS   256
#define BUF_SIZE      65536
#define ROOM_LEN      64

/* ---- tiny SHA-1 (public-domain style), needed for the WS handshake ---- */
typedef struct { uint32_t state[5]; uint64_t bitlen; unsigned char buf[64]; int idx; } SHA1_CTX;

#define ROL(v,b) (((v) << (b)) | ((v) >> (32 - (b))))

static void sha1_transform(SHA1_CTX *ctx, const unsigned char data[64]) {
    uint32_t w[80], a, b, c, d, e, t;
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)data[i*4] << 24) | ((uint32_t)data[i*4+1] << 16) |
               ((uint32_t)data[i*4+2] << 8) | (uint32_t)data[i*4+3];
    for (int i = 16; i < 80; i++)
        w[i] = ROL(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);

    a = ctx->state[0]; b = ctx->state[1]; c = ctx->state[2];
    d = ctx->state[3]; e = ctx->state[4];

    for (int i = 0; i < 80; i++) {
        uint32_t f, k;
        if (i < 20)      { f = (b & c) | (~b & d);          k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d;                   k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else             { f = b ^ c ^ d;                   k = 0xCA62C1D6; }
        t = ROL(a, 5) + f + e + k + w[i];
        e = d; d = c; c = ROL(b, 30); b = a; a = t;
    }
    ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c;
    ctx->state[3] += d; ctx->state[4] += e;
}

static void sha1_init(SHA1_CTX *ctx) {
    ctx->state[0] = 0x67452301; ctx->state[1] = 0xEFCDAB89;
    ctx->state[2] = 0x98BADCFE; ctx->state[3] = 0x10325476;
    ctx->state[4] = 0xC3D2E1F0; ctx->bitlen = 0; ctx->idx = 0;
}

static void sha1_update(SHA1_CTX *ctx, const unsigned char *data, size_t len) {
    for (size_t i = 0; i < len; i++) {
        ctx->buf[ctx->idx++] = data[i];
        ctx->bitlen += 8;
        if (ctx->idx == 64) { sha1_transform(ctx, ctx->buf); ctx->idx = 0; }
    }
}

static void sha1_final(unsigned char digest[20], SHA1_CTX *ctx) {
    uint64_t bitlen = ctx->bitlen;
    ctx->buf[ctx->idx++] = 0x80;
    if (ctx->idx > 56) {
        while (ctx->idx < 64) ctx->buf[ctx->idx++] = 0;
        sha1_transform(ctx, ctx->buf); ctx->idx = 0;
    }
    while (ctx->idx < 56) ctx->buf[ctx->idx++] = 0;
    for (int i = 7; i >= 0; i--) ctx->buf[ctx->idx++] = (bitlen >> (i * 8)) & 0xFF;
    sha1_transform(ctx, ctx->buf);
    for (int i = 0; i < 20; i++)
        digest[i] = (ctx->state[i >> 2] >> ((3 - (i & 3)) * 8)) & 0xFF;
}

/* ---- base64 encode (for the WS accept key) ---- */
static void b64(const unsigned char *in, int len, char *out) {
    static const char t[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int i, o = 0;
    for (i = 0; i < len; i += 3) {
        int n = in[i] << 16;
        if (i+1 < len) n |= in[i+1] << 8;
        if (i+2 < len) n |= in[i+2];
        out[o++] = t[(n >> 18) & 63];
        out[o++] = t[(n >> 12) & 63];
        out[o++] = (i+1 < len) ? t[(n >> 6) & 63] : '=';
        out[o++] = (i+2 < len) ? t[n & 63] : '=';
    }
    out[o] = 0;
}

/* ---- limits (DoS / abuse protection, per OWASP WebSocket guidance) ---- */
#define ROOM_CAP        4      /* max connections sharing one room */
#define RATE_WINDOW     10     /* seconds */
#define RATE_MAX        40     /* max messages per window per connection */
#define IDLE_TIMEOUT    120    /* drop a connection after this many idle seconds */

/* ---- per-connection state ---- */
typedef struct {
    int fd;
    int handshaked;
    char room[ROOM_LEN];
    time_t last_active;   /* for idle timeout */
    time_t win_start;     /* start of current rate window */
    int win_count;        /* messages seen in current window */
} Client;

static Client clients[MAX_CLIENTS];

/* How many connections are currently in a given room. */
static int room_count(const char *room) {
    int n = 0;
    for (int i = 0; i < MAX_CLIENTS; i++)
        if (clients[i].fd > 0 && strcmp(clients[i].room, room) == 0) n++;
    return n;
}

static void ws_accept_key(const char *key, char *out) {
    char cat[256];
    snprintf(cat, sizeof cat, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
    SHA1_CTX c; unsigned char d[20];
    sha1_init(&c);
    sha1_update(&c, (unsigned char *)cat, (uint32_t)strlen(cat));
    sha1_final(d, &c);
    b64(d, 20, out);
}

/* Complete the WebSocket handshake. Returns 1 on success. Also pulls the room
 * id out of the request path (?room=...). Nothing is logged. */
static int do_handshake(int fd, char *room_out) {
    char buf[BUF_SIZE];
    int n = recv(fd, buf, sizeof buf - 1, 0);
    if (n <= 0) return 0;
    buf[n] = 0;

    char *r = strstr(buf, "room=");
    if (r) {
        r += 5;
        int i = 0;
        while (r[i] && r[i] != ' ' && r[i] != '&' && r[i] != '\r' && i < ROOM_LEN - 1) {
            room_out[i] = r[i]; i++;
        }
        room_out[i] = 0;
    } else {
        strcpy(room_out, "lobby");
    }

    char *k = strstr(buf, "Sec-WebSocket-Key:");
    if (!k) return 0;
    k += 18;
    while (*k == ' ') k++;
    char key[128]; int i = 0;
    while (*k && *k != '\r' && *k != '\n' && i < 127) key[i++] = *k++;
    key[i] = 0;

    char accept[64];
    ws_accept_key(key, accept);

    char resp[256];
    int len = snprintf(resp, sizeof resp,
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n", accept);
    return send(fd, resp, len, 0) == len;
}

/* Send a raw text frame (server->client frames are never masked). */
static void ws_send(int fd, const unsigned char *payload, size_t len) {
    unsigned char hdr[10]; size_t hl;
    hdr[0] = 0x81; /* FIN + text */
    if (len < 126) { hdr[1] = (unsigned char)len; hl = 2; }
    else if (len < 65536) { hdr[1] = 126; hdr[2] = (len>>8)&255; hdr[3] = len&255; hl = 4; }
    else { hdr[1] = 127; for (int i=0;i<8;i++) hdr[2+i] = (len >> ((7-i)*8)) & 255; hl = 10; }
    send(fd, hdr, hl, 0);
    send(fd, payload, len, 0);
}

/* Relay a decoded payload to the OTHER client(s) in the same room. */
static void relay_to_room(int from_idx, const unsigned char *payload, size_t len) {
    for (int i = 0; i < MAX_CLIENTS; i++) {
        if (i == from_idx) continue;
        if (clients[i].fd > 0 && clients[i].handshaked &&
            strcmp(clients[i].room, clients[from_idx].room) == 0) {
            ws_send(clients[i].fd, payload, len);
        }
    }
}

/*
 * Read one client frame, unmask it, relay it. Returns 0 if the client closed
 * or sent something malformed (we drop such connections rather than guess).
 *
 * Every offset is checked against `n` (bytes actually received) BEFORE use, so
 * a short or lying length field can never index past the buffer. `n` is signed
 * and all comparisons keep both sides in a wide signed type, so there is no
 * unsigned-underflow trick.
 */
static int handle_frame(int idx) {
    unsigned char buf[BUF_SIZE];
    int n = recv(clients[idx].fd, buf, sizeof buf, 0);
    if (n <= 0) return 0;
    if (n < 2) return 0;

    int opcode = buf[0] & 0x0F;
    if (opcode == 0x8) return 0; /* close */

    int masked = buf[1] & 0x80;
    if (!masked) return 0; /* per spec, client frames MUST be masked */

    int64_t plen = buf[1] & 0x7F;
    int pos = 2;

    if (plen == 126) {
        if (n < 4) return 0;
        plen = ((int64_t)buf[2] << 8) | buf[3];
        pos = 4;
    } else if (plen == 127) {
        if (n < 10) return 0;
        plen = 0;
        for (int i = 0; i < 8; i++) plen = (plen << 8) | buf[2 + i];
        pos = 10;
        /* reject absurd/negative lengths outright */
        if (plen < 0 || plen > BUF_SIZE) return 0;
    }

    /* need 4 mask bytes after the header */
    if (pos + 4 > n) return 0;
    unsigned char mask[4];
    memcpy(mask, buf + pos, 4);
    pos += 4;

    /* the full payload must fit in what we actually read (no fragmentation
     * reassembly here — oversized frames are simply rejected) */
    if (plen < 0 || plen > (int64_t)(n - pos)) return 0;

    for (int64_t i = 0; i < plen; i++) buf[pos + i] ^= mask[i & 3];

    /* Rate limit: blunt a spamming/DoS client. Reset the window when it ages
     * out, then drop the connection if it exceeds the cap within one window. */
    time_t now = time(NULL);
    clients[idx].last_active = now;
    if (now - clients[idx].win_start >= RATE_WINDOW) {
        clients[idx].win_start = now;
        clients[idx].win_count = 0;
    }
    if (++clients[idx].win_count > RATE_MAX) return 0; /* too fast: disconnect */

    if (plen > 0) relay_to_room(idx, buf + pos, (size_t)plen);
    return 1;
}

int main(int argc, char **argv) {
    int port = (argc > 1) ? atoi(argv[1]) : 8080;

    int srv = socket(AF_INET, SOCK_STREAM, 0);
    int yes = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    if (bind(srv, (struct sockaddr *)&addr, sizeof addr) < 0) { perror("bind"); return 1; }
    listen(srv, 64);

    /* Startup line is the ONLY thing this server ever prints. No request logs. */
    printf("chat-anoynm relay listening on :%d (no logs, no storage)\n", port);
    fflush(stdout);

    struct pollfd fds[MAX_CLIENTS + 1];
    for (;;) {
        int nf = 0;
        fds[nf].fd = srv; fds[nf].events = POLLIN; fds[nf].revents = 0; nf++;
        for (int i = 0; i < MAX_CLIENTS; i++) {
            if (clients[i].fd > 0) { fds[nf].fd = clients[i].fd; fds[nf].events = POLLIN; fds[nf].revents = 0; nf++; }
        }

        /* Wake at least once a second so idle connections get reaped. */
        if (poll(fds, nf, 1000) < 0) { if (errno == EINTR) continue; break; }

        if (fds[0].revents & POLLIN) {
            int c = accept(srv, NULL, NULL);
            if (c >= 0) {
                setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof yes); /* low latency */
                int slot = -1;
                for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i].fd == 0) { slot = i; break; }
                if (slot < 0) { close(c); }
                else {
                    char room[ROOM_LEN];
                    if (do_handshake(c, room) && room_count(room) < ROOM_CAP) {
                        time_t now = time(NULL);
                        clients[slot].fd = c;
                        clients[slot].handshaked = 1;
                        strncpy(clients[slot].room, room, ROOM_LEN - 1);
                        clients[slot].room[ROOM_LEN - 1] = 0;
                        clients[slot].last_active = now;
                        clients[slot].win_start = now;
                        clients[slot].win_count = 0;
                    } else close(c); /* handshake failed OR room is full */
                }
            }
        }

        for (int i = 1; i < nf; i++) {
            if (!(fds[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            int idx = -1;
            for (int j = 0; j < MAX_CLIENTS; j++) if (clients[j].fd == fds[i].fd) { idx = j; break; }
            if (idx < 0) continue;
            if (!handle_frame(idx)) {
                close(clients[idx].fd);
                /* wipe the slot completely — nothing about this client survives */
                memset(&clients[idx], 0, sizeof(Client));
            }
        }

        /* Reap idle connections so abandoned sockets don't hold slots forever. */
        time_t now = time(NULL);
        for (int i = 0; i < MAX_CLIENTS; i++) {
            if (clients[i].fd > 0 && now - clients[i].last_active > IDLE_TIMEOUT) {
                close(clients[i].fd);
                memset(&clients[i], 0, sizeof(Client));
            }
        }
    }
    close(srv);
    return 0;
}
