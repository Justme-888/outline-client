// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/// <reference path='../../types/ambient/outlinePlugin.d.ts'/>

import * as errors from '../model/errors';
import * as events from '../model/events';
import {ProxyConfigSource, Server, ServerConfig} from '../model/server';

import {PersistentServer} from './persistent_server';

export class OutlineServer implements PersistentServer {
  // We restrict to AEAD ciphers because unsafe ciphers are not supported in outline-go-tun2socks.
  // https://shadowsocks.org/en/spec/AEAD-Ciphers.html
  private static readonly SUPPORTED_CIPHERS =
      ['chacha20-ietf-poly1305', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'];

  constructor(
      public readonly id: string, private tunnel: cordova.plugins.outline.Tunnel,
      private eventQueue: events.EventQueue) {
    this.tunnel.onStatusChange((status: TunnelStatus) => {
      let statusEvent: events.OutlineEvent;
      switch (status) {
        case TunnelStatus.CONNECTED:
          statusEvent = new events.ServerConnected(this);
          break;
        case TunnelStatus.DISCONNECTED:
          statusEvent = new events.ServerDisconnected(this);
          break;
        case TunnelStatus.RECONNECTING:
          statusEvent = new events.ServerReconnecting(this);
          break;
        default:
          console.warn(`Received unknown tunnel status ${status}`);
          return;
      }
      eventQueue.enqueue(statusEvent);
    });

    this.tunnel.onConfigSourceUrlChange((url: string) => {
      eventQueue.enqueue(new events.ServerConfigSourceUrlChanged(this, url));
    });
  }

  get config() {
    return this.tunnel.config;
  }

  get name() {
    return this.config.name || this.config.proxy ?.name || this.host || '';
  }

  set name(newName: string) {
    this.config.name = newName;
    if (this.config.proxy) {
      this.config.proxy.name = newName;
    }
  }

  get host() {
    if (this.config.proxy) {
      return `${this.config.proxy.host}:${this.config.proxy.port}`;
    }
    // TODO(alalama): refine which components of the source URL to show.
    return this.config.source ?.url || '';
  }

  async connect() {
    try {
      if (this.config.source) {
        const proxies = await this.tunnel.fetchProxyConfig();
        // TODO(alalama): policy
        this.config.proxy = proxies[0];
      }
      await this.tunnel.start();
    } catch (e) {
      if (this.config.source) {
        // Remove the proxy configuration in case fetching succeeded but connecting failed.
        delete this.config.proxy;
      }
      // e originates in "native" code: either Cordova or Electron's main process.
      // Because of this, we cannot assume "instanceof OutlinePluginError" will work.
      if (e.errorCode) {
        throw errors.fromErrorCode(e.errorCode);
      }
      throw e;
    }
  }

  async disconnect() {
    try {
      await this.tunnel.stop();
    } catch (e) {
      // All the plugins treat disconnection errors as ErrorCode.UNEXPECTED.
      throw new errors.RegularNativeError();
    } finally {
      if (this.config.source) {
        delete this.config.proxy;
      }
    }
  }

  checkRunning(): Promise<boolean> {
    return this.tunnel.isRunning();
  }

  checkReachable(): Promise<boolean> {
    return this.tunnel.isReachable();
  }

  public static isServerCipherSupported(cipher?: string) {
    return cipher !== undefined && OutlineServer.SUPPORTED_CIPHERS.includes(cipher);
  }
}
