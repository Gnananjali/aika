FROM node:20-alpine
WORKDIR /srv
# tcpdump records packets for the optional capture container (tiny; only used with --capture).
# This layer comes BEFORE the code copy so ordinary code changes do not re-download it.
RUN apk add --no-cache tcpdump && mkdir -p /capture
COPY . .