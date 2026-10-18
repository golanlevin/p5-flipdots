// Read-only discovery fixture. No serial port is opened by these CLI tests.
const { SerialPort } = require('serialport');
SerialPort.list = async () => [
  { path: 'COM3', manufacturer: 'Test adapter', serialNumber: 'FIRST', vendorId: '0403', productId: '6001' },
  { path: 'COM4', manufacturer: 'Test adapter', serialNumber: 'SECOND', vendorId: '0403', productId: '6001' },
];
Object.defineProperty(process.stdin, 'isTTY', { value: true });
