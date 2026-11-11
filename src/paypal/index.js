import { config } from '../config.js';
import * as real from './real.js';
import * as mock from './mock.js';

export const paypal = config.paypal.mock ? mock : real;
