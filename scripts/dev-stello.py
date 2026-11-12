#!/usr/bin/env python3
"""Start or stop Stellane's private Stello development deployment."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.stellane-dev' / 'stello'
OWNER = 'stellane-phase2'
NETWORK = 'stellane-phase2'
HOST = NETWORK + '-host'
OBJECTS = NETWORK + '-objects'
UBUNTU = 'ubuntu@sha256:69cecf4bbf72d2d44a9eef1b71fb98c7fb973d78af11399deccef19beb008ad9'
RUSTFS = 'rustfs/rustfs@sha256:97171b3d72cd47dc81000f92ea84de25608bfc35a94c965501afaeb5d99f6035'


def run(*args, input=None, check=True, timeout=60):
    result = subprocess.run(list(map(str, args)), input=input, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        # Provisioning argv and output may contain private connection material.
        (STATE / 'last-error.log').write_text(result.stderr + result.stdout)
        raise RuntimeError(f'{Path(str(args[0])).name} failed ({result.returncode}); inspect {STATE} locally')
    return result


def docker(*args, **kwargs):
    return run('docker', *args, **kwargs)


def inspect(kind, name):
    result = docker(kind, 'inspect', name, check=False)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None


def owned(kind, name):
    value = inspect(kind, name)
    labels = (value or {}).get('Labels', {}) if kind == 'network' else (value or {}).get('Config', {}).get('Labels', {})
    if value and labels.get('com.stellane.owner') != OWNER:
        raise RuntimeError(f'{name} is not owned by Stellane; stopped')
    return value


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def execute(*args, **kwargs):
    return docker('exec', *(['-i'] if kwargs.get('input') is not None else []), HOST,
                  '/usr/bin/env', 'STELLO_CLIENT_HOME=/node/client',
                  f'LD_LIBRARY_PATH={STATE}/install/lib:{STATE}/install/lib/x86_64-linux-gnu', *args, **kwargs)


def finish():
    install = STATE / 'install'
    docker('update', '--memory', '6g', '--memory-swap', '12g', '--cpus', '4', '--pids-limit', '1024', HOST)
    execute('python3', '-c', 'from pathlib import Path;import sys;'
            'Path("/etc/ld.so.conf.d/stellane.conf").write_text(sys.argv[1]+"/lib\\n"+sys.argv[1]+"/lib/x86_64-linux-gnu\\n")', str(install))
    execute('/usr/sbin/ldconfig', '-X')
    cli = install / 'bin/stello'
    applied = execute(cli, 'cluster', 'apply', '--file', '/node/spec.json', '--json', timeout=600)
    node = STATE / 'node'
    (node / 'apply.json').write_text(applied.stdout)
    existing = execute(cli, 'branch', 'get', 'stellane/main', '--json', check=False)
    if existing.returncode:
        execute(cli, 'database', 'create', 'stellane', '--json', timeout=300)
    execute(cli, 'connect', 'stellane/main', '--output', '/node/baseline', '--json')
    execute('env', 'PGSERVICEFILE=/node/baseline/pg_service.conf', install / 'bin/psql', '-X', '-v', 'ON_ERROR_STOP=1',
            'service=stello', '-c', "CREATE TABLE IF NOT EXISTS demo_orders (id integer PRIMARY KEY, customer text NOT NULL, quantity integer NOT NULL, status text NOT NULL); "
            "INSERT INTO demo_orders VALUES (1,'北辰',120,'待交付'),(2,'云川',80,'已发货'),(3,'星河',160,'待交付') ON CONFLICT DO NOTHING;")
    if execute('test', '-f', '/node/export/client.json', check=False).returncode:
        execute(cli, 'context', 'export', '--output', '/node/export', '--json')
    execute('chown', '-R', f'{os.getuid()}:{os.getgid()}', '/node/export')
    save(STATE / 'provider.json', {'name': 'Stellane 分支开发库', 'projectPath': str(ROOT),
         'configPath': str(node / 'export/client.json'), 'resource': 'stellane/main'})
    print(f'Stellane private Stello ready. Provider fields: {STATE / "provider.json"}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start', 'stop'], nargs='?', default='start')
    parser.add_argument('--source', type=Path, default=Path(os.environ['STELLO_SOURCE']) if os.environ.get('STELLO_SOURCE') else None)
    parser.add_argument('--prefix', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    host, objects = owned('container', HOST), owned('container', OBJECTS)
    network = owned('network', NETWORK)
    if args.command == 'stop':
        for name, value in [(HOST, host), (OBJECTS, objects)]:
            if value:
                docker('stop', name, timeout=90)
        print('Stellane Stello stopped; containers, data and credentials retained.')
        return
    if host:
        if not objects or not network:
            raise RuntimeError('Incomplete owned deployment; inspect private state before continuing')
        if not objects['State']['Running']:
            docker('start', OBJECTS)
        if not host['State']['Running']:
            docker('start', HOST)
        finish()
        print(f'Existing owned Stello deployment: {STATE / "provider.json"}')
        return
    if objects or network:
        raise RuntimeError('Partial owned deployment exists; inspect it rather than overwrite its data')
    if args.source is None:
        parser.error('set STELLO_SOURCE or pass --source /path/to/Stello')
    source = args.source.resolve(strict=True)
    prefix = (args.prefix or source / 'build-layout/pg14-current/install').resolve(strict=True)
    install = STATE / 'install'
    if not install.exists():
        # Copy-on-write snapshot: never mount mutable artifacts from another test.
        run('cp', '-a', '--reflink=auto', prefix, install, timeout=120)
    info = run('git', '-C', source, 'rev-parse', 'HEAD').stdout.strip()
    save(STATE / 'build.json', {'source': str(source), 'head': info,
         'dirty': bool(run('git', '-C', source, 'status', '--porcelain').stdout), 'originalPrefix': str(prefix)})
    node = STATE / 'node'
    units = STATE / 'units'
    node.mkdir(mode=0o700)
    units.mkdir(mode=0o700)
    for unit in ['systemd-udevd.service', 'systemd-udevd-control.socket', 'systemd-udevd-kernel.socket',
                 'systemd-modules-load.service', 'systemd-sysctl.service', 'systemd-remount-fs.service',
                 'systemd-tmpfiles-setup.service', 'systemd-tmpfiles-setup-dev.service', 'systemd-logind.service']:
        (units / unit).symlink_to('/dev/null')
    docker('network', 'create', '--internal', '--label', f'com.stellane.owner={OWNER}', NETWORK)
    access, secret = secrets.token_hex(16), secrets.token_hex(32)
    envfile = STATE / 'objects.env'
    envfile.write_text(f'RUSTFS_ACCESS_KEY={access}\nRUSTFS_SECRET_KEY={secret}\nRUSTFS_CONSOLE_ENABLE=false\n')
    docker('run', '-d', '--name', OBJECTS, '--network', NETWORK, '--label', f'com.stellane.owner={OWNER}',
           '--memory', '512m', '--cpus', '1', '--env-file', envfile, RUSTFS, '/data')
    command = ['run', '-d', '--name', HOST, '--network', NETWORK, '--label', f'com.stellane.owner={OWNER}',
               '--privileged', '--cgroupns=private', '--memory', '6g', '--cpus', '4', '--pids-limit', '1024', '--tmpfs', '/run', '--tmpfs', '/run/lock',
               '--tmpfs', '/tmp:rw,mode=1777,size=256m', '--env', 'container=docker',
               '--mount', f'type=bind,src={units},dst=/etc/systemd/system',
               '--mount', f'type=bind,src={node},dst=/node',
               '--mount', f'type=bind,src={install},dst={install},readonly']
    for path in ['/usr/bin', '/usr/lib', '/lib', '/lib64', '/etc/passwd', '/etc/group', '/etc/pam.d',
                 '/usr/share', '/etc/ssl/openssl.cnf']:
        command += ['--mount', f'type=bind,src={path},dst={path},readonly']
    docker(*command, UBUNTU, '/lib/systemd/systemd', '--unit=multi-user.target', '--log-level=warning')
    deadline = time.monotonic() + 30
    while execute('systemctl', 'show', '--property=Version', check=False).returncode:
        if time.monotonic() > deadline:
            raise RuntimeError('Private systemd host did not start')
        time.sleep(.2)
    execute('python3', '-c', 'import os,stat;[(os.mknod("/dev/loop"+str(i),stat.S_IFBLK|0o600,os.makedev(7,i))) '
            'for i in range(128) if not os.path.exists("/dev/loop"+str(i))]')
    address = inspect('container', HOST)['NetworkSettings']['Networks'][NETWORK]['IPAddress']
    object_address = inspect('container', OBJECTS)['NetworkSettings']['Networks'][NETWORK]['IPAddress']
    subnet = inspect('network', NETWORK)['IPAM']['Config'][0]['Subnet']
    objects_config = {'endpoint': f'http://{object_address}:9000', 'bucket': 'stellane', 'region': 'us-east-1',
                      'access_key': access, 'secret_key': secret}
    save(node / 'objects.json', objects_config)
    spec = importlib.util.spec_from_file_location('stello_s3', source / 'tests/compatibility/s3_contract.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    store = module.S3(objects_config['endpoint'], access, secret)
    deadline = time.monotonic() + 30
    while True:
        try:
            if store.request('PUT', '/stellane')[0] in (200, 409):
                break
        except OSError:
            pass
        if time.monotonic() > deadline:
            raise RuntimeError('Owned object storage did not become ready')
        time.sleep(.2)
    save(node / 'spec.json', {'version': 1, 'name': 'stellane', 'prefix': str(install),
         'root': '/srv/stello/stellane', 'user': os.environ.get('USER', 'nail'),
         'machines': {'node1': {'address': address, 'ssh': None}}, 'wal': ['node1'], 'page': 'node1',
         'computes': ['node1'], 'object_store': '/node/objects.json', 'slots_per_compute': 8,
         'disk_bytes_per_slot': 1024**3, 'memory_bytes_per_slot': 512*1024**2,
         'sql_client_cidr': subnet, 'replication_cidr': address + '/32', 'managed_objects': False})
    finish()


if __name__ == '__main__':
    main()
