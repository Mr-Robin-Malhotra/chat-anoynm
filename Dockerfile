# Build the C relay and run it. Tiny image: compile stage + minimal runtime.
FROM gcc:14 AS build
WORKDIR /src
COPY server.c .
RUN cc -O2 -Wall -o server server.c

FROM debian:bookworm-slim
COPY --from=build /src/server /usr/local/bin/server
# The server reads $PORT if set (Render sets it to 10000), else defaults to 8080.
ENV PORT=10000
EXPOSE 10000
CMD ["server"]
