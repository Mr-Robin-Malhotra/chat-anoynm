# Build the C relay as a static binary and run it on a minimal base.
# Static linking avoids any glibc-version mismatch between build and run images
# (a common cause of "container starts then exits" on hosts like Render).
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY server.c .
RUN cc -O2 -Wall -static -o server server.c

FROM debian:bookworm-slim
COPY --from=build /src/server /usr/local/bin/server
# The server reads $PORT (Render injects it), else defaults to 8080.
ENV PORT=10000
EXPOSE 10000
CMD ["server"]
