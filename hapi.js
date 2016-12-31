/**
 * Exposes HAPI integration for the mock server
 */
var Hapi = require('hapi');
var _ = require('lodash');
var util = require('./lib/util');
var _inputs = {
  boolean: require('./lib/admin/api/input-plugins/checkbox'),
  text: require('./lib/admin/api/input-plugins/text'),
  select: require('./lib/admin/api/input-plugins/select'),
  multiselect: require('./lib/admin/api/input-plugins/multiselect')
};

module.exports = function (smocks) {
  smocks = smocks || require('./lib').lastSmocksInstance;

  return {
    toPlugin: function (hapiPluginOptions, smocksOptions) {
      var register = function (server, pluginOptions, next) {
        function _next (err) {
          if (err) {
            next(err);
          } else {
            configServer(server);
            next();
          }
        }

        hapiPluginOptions = hapiPluginOptions || {};
        smocksOptions = smocksOptions || {};

        smocks._sanityCheckRoutes();
        // allow for plugin state override
        if (register.overrideState) {
          smocksOptions.state = register.overrideState;
        }
        smocksOptions = smocks._sanitizeOptions(smocksOptions);
        smocks.options = smocksOptions;
        smocks.state = smocksOptions.state;

        if (hapiPluginOptions.onRegister) {
          hapiPluginOptions.onRegister(server, pluginOptions, _next);
        } else {
          _next();
        }
      };
      return register;
    },

    start: function (hapiOptions, smocksOptions) {
      if (!smocks.id()) {
        throw new Error('You must set an id value for the smocks instance... smocks.id("my-project")');
      }

      hapiOptions = hapiOptions || {};
      var hapiServerOptions = hapiOptions.server;
      var hapiConnectionOptions = hapiOptions.connection;
      if (!hapiServerOptions && !hapiConnectionOptions) {
        hapiConnectionOptions = hapiOptions;
      }
      smocksOptions = smocks._sanitizeOptions(smocksOptions || {});
      smocks.state = smocksOptions.state;
      smocks.options = smocksOptions;
      smocks._sanityCheckRoutes();

      if (!hapiConnectionOptions.routes) {
        hapiConnectionOptions.routes = { cors: true };
      }

      var server = new Hapi.Server(hapiServerOptions);
      server.connection(hapiConnectionOptions);

      configServer(server);
      server.start(function (err) {
        if (err) {
          console.error(err.message);
          process.exit(1);
        }
      });
      console.log('started smocks server on ' + hapiConnectionOptions.port + '.  visit http://localhost:' + hapiConnectionOptions.port + ' to configure');

      return {
        server: server,
        start: function (options) {
          self.start(options);
        }
      };
    }
  };


  function wrapReply (request, reply, plugins) {
    var rtn = function () {
      var response = reply.apply(this, arguments);
      if (smocks.state.onResponse) {
        smocks.state.onResponse(request, response);
      }
      _.each(plugins, function (plugin) {
        if (plugin.onResponse) {
          plugin.onResponse(request, response);
        }
      });
      return response;
    };
    _.each(['continue', 'file', 'view', 'close', 'proxy', 'redirect'], function (key) {
      rtn[key] = function () {
        reply[key].apply(reply, arguments);
      };
    });
    return rtn;
  }

  function configServer (server) {
    // set the input types on the smocks object
    smocks.input = function (type, options) {
      _inputs[type] = options;
    };
    smocks.inputs = {
      get: function () {
        return _inputs;
      }
    };

    var _routes = smocks.routes.get();
    var _plugins = smocks.plugins.get();

    _.each(_routes, function (route) {
      if (route.hasVariants()) {

        var connection = server;

        if (route.connection()) {
          connection = server.select(route.connection());
        }
        connection.route({
          method: route.method(),
          path: route.path(),
          config: route.config(),
          handler: function (request, reply) {

            function doInit () {
              _.each(_routes, function (route) {
                route.resetRouteVariant(request);
                route.resetSelectedInput(request);
              });
              smocks.plugins.resetInput(request);
              var initialState = JSON.parse(JSON.stringify(smocks.options.initialState || {}));
              smocks.state.resetUserState(request, initialState);
            }

            function doExecute() {
              if (smocks.state.onRequest) {
                smocks.state.onRequest(request, reply);
              }

              var pluginIndex = 0;
              function handlePlugins() {
                var plugin = _plugins[pluginIndex++];
                var context;
                if (plugin) {
                  if (plugin.onRequest) {
                    context = util.executionContext({
                      request: request,
                      route: route,
                      plugin: plugin,
                      smocks: smocks
                    });
                    plugin.onRequest.call(context.setup(), request, reply, handlePlugins);
                    context.teardown();
                  } else {
                    handlePlugins();
                  }
                } else {
                  context = util.executionContext({
                    request: request,
                    route: route,
                    smocks: smocks
                  });
                  reply = wrapReply(request, reply, _plugins);
                  route._handleRequest(request, reply, context.setup());
                  context.teardown();
                }
              }

              handlePlugins();
            }

            smocks.state.initialize(request, function (err, performInitialization) {
              if (performInitialization) {
                doInit();
              }
              doExecute();
            });
          }
        });
      }
    }, this);

    require('./lib/admin')(server, smocks);
  }
}

// allow for backwards compatibility
_.each(['start', 'toPlugin'], function (key) {
  var lastSmocksInstance = require('./index').lastSmocksInstance;
  if (!lastSmocksInstance) {
    throw new Error('you must call smocks(_id_) before calling `smocks/hapi.' + key + '`');
  }
  module.exports[key] = function () {
    return module.exports(lastSmocksInstance)[key].apply(this, arguments);
  }
});
