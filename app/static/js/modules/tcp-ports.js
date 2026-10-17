// The TCP port numbers MetaList accepts, mirroring app/utils/tcp_ports.py
// (tests/unit/test_tcp_ports.py keeps the two equal).

export const LOWEST_PORT = 1;
export const HIGHEST_PORT = 65535;
export const PORT_RANGE_TEXT = `between ${LOWEST_PORT} and ${HIGHEST_PORT}`;

export function isTcpPort(value) {
    return Number.isInteger(value) && value >= LOWEST_PORT && value <= HIGHEST_PORT;
}
