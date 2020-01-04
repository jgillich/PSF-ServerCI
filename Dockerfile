FROM mozilla/sbt

# https://github.com/boxboat/fixuid
RUN addgroup --gid 1000 psfci && \
    adduser --uid 1000 --ingroup psfci --home /home/psfci --shell /bin/bash --disabled-password --gecos "" psfci

RUN USER=psfci && \
    GROUP=psfci && \
    curl -SsL https://github.com/boxboat/fixuid/releases/download/v0.4/fixuid-0.4-linux-amd64.tar.gz | tar -C /usr/local/bin -xzf - && \
    chown root:root /usr/local/bin/fixuid && \
    chmod 4755 /usr/local/bin/fixuid && \
    mkdir -p /etc/fixuid && \
    printf "user: $USER\ngroup: $GROUP\n" > /etc/fixuid/config.yml

USER psfci:psfci
ENTRYPOINT ["fixuid"]
