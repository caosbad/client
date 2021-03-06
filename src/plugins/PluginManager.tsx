import AbstractGameManager from '../api/AbstractGameManager';
import AbstractUIManager from '../app/board/AbstractUIManager';
import { PluginId, SerializedPlugin } from './SerializedPlugin';
import { v4 as uuidv4 } from 'uuid';
import { PluginProcess } from './PluginProcess';
import { UIDataKey } from '../api/UIStateStorageManager';
import { PluginHelpers } from './PluginHelpers';
import { README_PLUGIN } from './examples/ReadmePlugin';
import { ARTIFACT_FINDER_PLUGIN } from './examples/ArtifactsFinderPlugin';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function makePluginFn(code: string) {
  return new AsyncFunction('df', 'ui', 'plugin', code);
}

/**
 * Represents book-keeping information about a running process. We keep it
 * separate from the process code, so that the plugin doesn't accidentally
 * overwrite this information.
 *
 */
export class ProcessInfo {
  rendered = false;
  hasError = false;
}

/**
 * This class keeps track of all the plugins that this player has loaded
 * into their game. Acts as a task manager, supports all CRUD operations
 * for plugins, as well as instantiating and destroying running plugins.
 * All library operations are also persisted to IndexDB.
 *
 * Important! Does not run plugins until the user clicks 'run' somewhere in
 * this UI. This is important, because if someone develops a buggy plugin,
 * it would suck if that bricked their game.
 */
export class PluginManager {
  /**
   * We want to give plugins access to the game state, so we must store
   * a reference to this game's {@link GameManager} instance.
   */
  private gameManager: AbstractGameManager;

  /**
   * Same as `gameManager` -we want to give plugins access to the game ui,
   * so we must store a reference to this game's {@link GameManager} instance.
   */
  private uiManager: AbstractUIManager;

  /**
   * All the plugins in the player's library. Not all of the player's plugins
   * are running, and therefore not all exist in `pluginInstances`.
   * `PluginsManager` keeps this field in sync with the plugins the user has
   * saved in the IndexDB via {@link PersistentChunkStore}
   */
  private pluginLibrary: SerializedPlugin[];

  /**
   * Plugins that are currently loaded into the game, and are rendering into a
   * window. `PluginsManager` makes sure that when a plugin starts executing, it
   * is added into `pluginInstances`, and that once a plugin is unloaded, its
   * `.destroy()` method is called, and that the plugin is removed from
   * `pluginInstances`.
   */
  private pluginProcesses: Record<string, PluginProcess>;

  /**
   * parallel to pluginProcesses
   */
  private pluginProcessInfos: Record<string, ProcessInfo>;

  public constructor(
    gameManager: AbstractGameManager,
    uiManager: AbstractUIManager
  ) {
    this.gameManager = gameManager;
    this.uiManager = uiManager;
    this.pluginLibrary = [];
    this.pluginProcesses = {};
    this.pluginProcessInfos = {};
  }

  /**
   * If a plugin with the given id is running, call its `.destroy()` method,
   * and remove it from `pluginInstances`.
   */
  public destroy(id: PluginId): void {
    if (this.pluginProcesses[id]) {
      try {
        const process = this.pluginProcesses[id];
        if (process && typeof process.destroy === 'function') {
          // TODO: destroy should also receive the element to cleanup event handlers, etc
          process.destroy();
        }
      } catch (e) {
        this.pluginProcessInfos[id].hasError = true;
        console.log('error when destroying plugin', e);
      } finally {
        delete this.pluginProcesses[id];
        delete this.pluginProcessInfos[id];
      }
    }
  }

  /**
   * Load all plugins from this disk into `pluginLibrary`. If it's
   * this player's first time loading the game, then insert the README
   * plugin into their plugin library. Effectively idempotent after the
   * first time you call it.
   */
  public async load(): Promise<void> {
    if (!this.uiManager.getUIDataItem(UIDataKey.hasAddedDefaultPlugins)) {
      this.uiManager.setUIDataItem(UIDataKey.hasAddedDefaultPlugins, true);
      this.addPluginToLibrary('README', README_PLUGIN);
      this.addPluginToLibrary('Artifacts Finder', ARTIFACT_FINDER_PLUGIN);
    }

    this.pluginLibrary = await this.gameManager.loadPlugins();
  }

  /**
   * Remove the given plugin both from the player's library, and kills
   * the plugin if it is running.
   */
  public async deletePlugin(pluginId: PluginId): Promise<void> {
    this.pluginLibrary = this.pluginLibrary.filter((p) => p.id !== pluginId);
    this.destroy(pluginId);
    await this.gameManager.savePlugins(this.pluginLibrary);
  }

  /**
   * Gets the serialized plugin with the given id from the player's plugin
   * library. `undefined` if no plugin exists.
   */
  public getPluginFromLibrary(id?: PluginId): SerializedPlugin | undefined {
    return this.pluginLibrary.find((p) => p.id === id);
  }

  /**
   * 1) kills the plugin if it's running
   * 2) edits the plugin-library version of this plugin
   * 3) if a plugin was edited, save the plugin library to disk
   */
  public overwritePlugin(
    newName: string,
    pluginCode: string,
    id: PluginId
  ): void {
    this.destroy(id);

    const plugin = this.getPluginFromLibrary(id);

    if (plugin) {
      plugin.code = pluginCode;
      plugin.name = newName;
      plugin.lastEdited = new Date().getTime();
      this.gameManager.savePlugins(this.pluginLibrary);
    }
  }

  /**
   * adds a new plugin into the plugin library.
   */
  public addPluginToLibrary(name: string, code: string): SerializedPlugin {
    const newPlugin = {
      code,
      name,
      lastEdited: new Date().getTime(),
      enabled: true,
      id: uuidv4() as PluginId,
    };

    this.pluginLibrary.push(newPlugin);
    this.gameManager.savePlugins(this.pluginLibrary);

    return PluginManager.copy(newPlugin);
  }

  /**
   * Either spawns the given plugin by evaluating its `pluginCode`, or
   * returns the already running plugin instance. If starting a plugin
   * throws an error then returns `undefined`.
   */
  public async spawn(id: PluginId): Promise<PluginProcess | undefined> {
    if (this.pluginProcesses[id as string]) {
      return this.pluginProcesses[id as string];
    }

    const plugin = this.getPluginFromLibrary(id);

    if (!plugin) {
      return;
    }

    this.pluginProcessInfos[plugin.id] = new ProcessInfo();

    try {
      const register = (plugin: PluginProcess) => {
        if (this.pluginProcesses[id] === undefined) {
          this.pluginProcesses[id] = plugin;
        }
      };
      const pluginHelpers = new PluginHelpers(register);
      // instantiate the plugin
      const pluginFn = makePluginFn(plugin.code);
      await pluginFn(this.gameManager, this.uiManager, pluginHelpers);
    } catch (e) {
      console.error('failed to start plugin', e);
      this.pluginProcessInfos[id].hasError = true;
    }

    return this.pluginProcesses[plugin.id];
  }

  /**
   * If this plugin's `render` method has not been called yet, then
   * call it! Remembers that this plugin has been rendered.
   */
  public async render(id: PluginId, element: HTMLDivElement): Promise<void> {
    const process = await this.spawn(id);
    const processInfo = this.pluginProcessInfos[id];

    if (
      process &&
      typeof process.render === 'function' &&
      processInfo &&
      !processInfo.rendered
    ) {
      try {
        // Allows a plugin render to be async which in turns allows
        // any method to be async since this is the entry point into it
        await process.render(element);
        processInfo.rendered = true;
      } catch (e) {
        processInfo.hasError = true;
        console.log('failed to render plugin', e);
      }
    }
  }

  /**
   * Gets all the plugins in this player's library.
   */
  public getLibrary(): SerializedPlugin[] {
    return this.pluginLibrary.map(PluginManager.copy);
  }

  /**
   * If this process has been started, gets its info
   */
  public getProcessInfo(id: PluginId): ProcessInfo {
    return PluginManager.copy(this.pluginProcessInfos[id as string]);
  }

  /**
   * Gets a map of all the currently running processes
   */
  public getAllProcessInfos(): Map<PluginId, ProcessInfo> {
    const map = new Map();

    for (const id of Object.getOwnPropertyNames(this.pluginProcessInfos)) {
      map.set(id as PluginId, PluginManager.copy(this.pluginProcessInfos[id]));
    }

    return map;
  }

  /**
   * To prevent users of this class from modifying our plugins library,
   * we return clones of the plugins. This should probably be a function
   * in a Utils file somewhere, but I thought I should leave a good comment
   * about why we return copies of the plugins from the library.
   */
  private static copy<T>(plugin: T): T {
    return JSON.parse(JSON.stringify(plugin)) as T;
  }
}
