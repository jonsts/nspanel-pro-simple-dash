FROM php:8.2-fpm-alpine

# Install nginx, gettext, and openssl
RUN apk add --no-cache nginx gettext openssl

# Generate self-signed SSL certificate
RUN mkdir -p /etc/nginx/ssl && \
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/key.pem \
    -out /etc/nginx/ssl/cert.pem \
    -subj "/C=US/ST=State/L=City/O=Organization/CN=simpledash.local"

# Copy nginx config template
COPY nginx.conf.template /etc/nginx/nginx.conf.template

# Copy dashboard files
COPY index.html /usr/share/nginx/html/index.html
COPY styles.css /usr/share/nginx/html/styles.css
COPY app.js /usr/share/nginx/html/app.js
COPY api.php /usr/share/nginx/html/api.php
COPY sound.mp3 /usr/share/nginx/html/sound.mp3
COPY vendor/ /usr/share/nginx/html/vendor/

# Create data directory
RUN mkdir -p /data && chown -R www-data:www-data /data

# Copy startup script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["sh", "-c", "php-fpm -D && nginx -g 'daemon off;'"]
