# Build the C relay and run it. Tiny image: compile stage + minimal runtime.
FROM gcc:14 AS build
WORKDIR /src
COPY server.c .
RUN cc -O2 -Wall -o server server.c

FROM debian:bookworm-slim
COPY --from=build /src/server /usr/local/bin/server
# Fly routes external 443/80 to this internal port.
EXPOSE 8080
CMD ["server", "8080"]
