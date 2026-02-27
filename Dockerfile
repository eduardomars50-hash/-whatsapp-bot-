FROM oven/bun:1

WORKDIR /app

COPY package.json ./
RUN bun install

COPY bot.ts ./

# Auth dir — mount a Railway Volume here to persist credentials across deploys
# Railway: Settings → Volumes → Mount at /app/auth
ENV AUTH_DIR=/app/auth

EXPOSE 8891

CMD ["bun", "run", "bot.ts"]
