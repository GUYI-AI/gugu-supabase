"""Owned loopback SMTP peer; never opens an outbound connection."""
import json
import pathlib
import socket
import ssl
import sys

root, mode, lose_reply = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3] == 'true'
listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(1); listener.settimeout(4)
print(json.dumps({'port': listener.getsockname()[1]}), flush=True)
record = {'connections': 0, 'commands': [], 'bodies': []}
connection = reader = None
try:
    connection, _ = listener.accept(); record['connections'] += 1; connection.settimeout(4)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.minimum_version = ssl.TLSVersion.TLSv1_2
    if mode != 'plain': context.load_cert_chain(root / 'cert.pem', root / 'key.pem')
    encrypted = mode == 'implicit_tls'
    if encrypted: connection = context.wrap_socket(connection, server_side=True)
    reader = connection.makefile('rb')
    def reply(value): connection.sendall(value.encode('ascii'))
    reply('220 loopback SMTP fixture\r\n')
    auth, data, body = 0, False, []
    while True:
        raw = reader.readline(65537)
        if not raw: break
        if len(raw) > 65536: raise ValueError('line too long')
        line = raw.decode('utf-8', errors='replace').removesuffix('\r\n')
        if data:
            if line != '.': body.append(line); continue
            record['bodies'].append('\r\n'.join(body)); data = False
            if lose_reply: break
            reply('250 queued by the loopback fixture\r\n'); continue
        if auth:
            record['commands'].append('AUTH_USERNAME' if auth == 1 else 'AUTH_PASSWORD')
            reply('334 UGFzc3dvcmQ6\r\n' if auth == 1 else '235 authenticated\r\n'); auth = 2 if auth == 1 else 0; continue
        command = line.split(' ')[0].upper(); record['commands'].append(command)
        if command == 'EHLO':
            extension = 'STARTTLS' if mode == 'starttls' and not encrypted else 'AUTH LOGIN'
            reply('250-loopback\r\n250-' + extension + '\r\n250 SIZE 65536\r\n')
        elif command == 'STARTTLS':
            if mode != 'starttls' or encrypted: reply('454 STARTTLS unavailable\r\n'); continue
            reply('220 start TLS\r\n'); reader.close(); reader = None
            connection = context.wrap_socket(connection, server_side=True); encrypted = True; reader = connection.makefile('rb')
        elif command == 'AUTH': auth = 1; reply('334 VXNlcm5hbWU6\r\n')
        elif command == 'DATA': data, body = True, []; reply('354 send message\r\n')
        elif command == 'QUIT': reply('221 closing\r\n'); break
        else: reply('250 ok\r\n')
except (OSError, ValueError) as error:
    record['fixture_error_type'] = type(error).__name__
finally:
    if reader is not None: reader.close()
    if connection is not None: connection.close()
    listener.close()
print(json.dumps(record), flush=True)
