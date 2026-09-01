FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN addgroup -S fifoo && adduser -S fifoo -G fifoo && chown -R fifoo:fifoo /app
USER fifoo
EXPOSE 3000
CMD ["npm", "start"]
