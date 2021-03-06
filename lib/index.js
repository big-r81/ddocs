var async     = require('async')
  , path      = require('path')
  //, COUCHAPP  = require('couchapp') -- waiting for :https://github.com/mikeal/node.couchapp.js/issues/104
  , COUCHAPP  = require('./couchapp/main')
  , LOG       = require('log4js').getLogger("lib/push")
  , o         = require('o-core')
  ;

//expose inner stages for testing, de-contextualized 
push.loadAttachments    = loadAttachments;
push.handleOnLoadedHook = handleOnLoadedHook;
push.handleLib          = handleLib;
push.handleViewsLib     = handleViewsLib;

module.exports = push;

LOG.debug("module loaded");

function push(args, done) {
    //input checks - raw level
    if (  !args
       || 'object' != typeof args
       || !args.push
       || Array.isArray(args.push)
       || !Object.keys(args.push).length
       ) {
        return done(new Error("options must be an object, and contain attribute 'push' - dictionary of ddocs commands to handle with at least one command"));
    }

    var ddocs    = args.push
      //dependency injection for tests
      , log      = args.log || LOG
      , couchapp = args.couchapp || COUCHAPP
      , errs
      ;

    //input checks - deeper
    if ( ( errs = 
            Object.keys(ddocs).filter(function(name) { 
                var cmd = ddocs[name];
                return !cmd
                    || 'object' != typeof cmd
                    || !cmd.basedir
                    || !cmd.src
                    || !cmd.host
                    || !cmd.dbs && Array.isArray(cmd.dbs)
            })
          ).length
        )
         return done(new Error("not all settings found. " + errs ));

    log.info("will handle docs : %s", Object.keys( ddocs ));

    async.eachSeries( Object.keys(ddocs)
    , handleOneDoc
    , done
    )

    function handleOneDoc(name, done) {
        var cmd      = ddocs[name]
          , filepath 
          , app
          , err
          ;
        log.debug('[%s] - handling', name, cmd);

        filepath = path.resolve( path.join( cmd.src , cmd.name ) )
        //TRICKY: hide password from log
        cmd.hostnocreds = cmd.host.replace(/(http|https):\/\/(.*)@.*:/, function(_,protocol,usr) { return protocol + "://" + usr + "@******" } );

        log.debug("[%s] - loading module from ", name, cmd.src);

        try {
            process.chdir( cmd.basedir ) 
            app = require( filepath );
        } catch (ex) {
            ex.package = args.package;
            ex.doc = name;
            ex.filepath = filepath;
            return done(ex)
        }
        
        
        couchapp.createApp( app, function(app) {

              //load attchments, or yield error
              if (err = loadAttachments(app, cmd)) return done(err);

              //run on loaded hook, or yield error
              if (err = handleOnLoadedHook(app, cmd)) return done(err);

              if (err = handleLib(app, cmd)) return done(err);

              if (err = handleViewsLib(app, cmd)) return done(err);

              log.debug("[%s] - will push to [%s] on ", name, cmd.dbs, cmd.hostnocreds);

              async.eachSeries( cmd.dbs
              , function(db, next) {
                    log.debug("[%s] - pushing to [%s] on ", name, db, cmd.hostnocreds);

                    app.push( cmd.host + db, function(err) {
                        log.info("[%s] - pushed to [%s%s]: %s " , name, cmd.hostnocreds, db, err || "Success")    
                        next(err);
                    })
                }
              , done
              )
          }
        )
    }

    function loadAttachments(app, cmd) {
        return push.loadAttachments(app, cmd, couchapp, log)
    }
    
    function handleOnLoadedHook(app, cmd) {
        return push.handleOnLoadedHook(app, cmd, couchapp, log)
    }

    function handleViewsLib(app, cmd) {
        return push.handleViewsLib(app, cmd, couchapp, log)
    }

    function handleLib(app, cmd) {
        return push.handleLib(app, cmd, couchapp, log)
    }
}

function validateCmd(cmd) {
}

function loadAttachments(app, cmd, couchapp, log) {
    if (!cmd.att) return;

    if ('string' == typeof (cmd.att) ) cmd.att = [cmd.att];

    if ('object' != cmd.att)
        return new Error("document attachments are expected to be an Array");

    if (!Array.isArray(cmd.att)) //convert { <path> : <prefix> }  to { path : <path> , prefix : <prefix> }
        cmd.att = 
          Object
            .keys( cmd.att )
            .reduce( function(att, path ) { 
                att.push( { root: path , prefix: cmd.att[path] } );
                return att
            }, [])

    cmd.att.forEach(function(item) {
        couchapp.loadAttachments( app, item.root, item.prefix )
    })
}

function handleOnLoadedHook(app, cmd, couchapp, log) { 
    if (!cmd.onloaded) return log.debug("[%s] - no onloaded hook found", cmd.name);

    var hookpath = path.resolve( path.join( cmd.basedir, cmd.onloaded ) )
      , hook
      , err
      ;
    log.debug("[%s] - handling onloaded hook", cmd.name);
    try {
        hook = require( hookpath );
        log.debug("[%s] - onloaded hook loaded", cmd.name);
        hook(app, cmd, couchapp)
    } catch (ex) {
        err = ex
    }
    if (!err) return log.info("[%s] - onloaded hook applied successfully");

    err.name     = cmd.name;
    err.onloaded = onLoad;
    err.hookpath = hookpath;
    return err;
}

function handleLib(app, cmd, couchapp, log) {
    if (!cmd["lib"]) return log.debug("[%s] - has no 'lib' directive", cmd.name);

    if (!app.doc.lib) app.doc.lib = {};
    return _handleLib(cmd.lib, app.doc.lib, cmd, couchapp, log, "doc.lib")
}

function handleViewsLib(app, cmd, couchapp, log) {
    if (!cmd["viewsLib"]) return log.debug("[%s] - has no 'viewsLib' directive", cmd.name);

    if (!app.doc.views) app.doc.views = {};
    if (!app.doc.views.lib) app.doc.views.lib = {};
    return _handleLib(cmd.viewsLib, app.doc.views.lib, cmd, couchapp, log, "views.lib")
}

function _handleLib(libDirs, trg, cmd, couchapp, log, logterm) {
    var cur;
    try {
        libDirs.forEach( function(libRootDir) {
            var absRootDir = path.resolve( path.join( cmd.basedir, cmd.src, libRootDir ) );
            log.debug("[%s] - loading into %s from [%s]", cmd.name, logterm, cur = libRootDir);
            o.extend( trg, couchapp.loadFiles( absRootDir ) )
        })
    } catch (ex) {
        ex.name = cmd.name;
        ex.libs = libDirs;
        ex.failedOn = cur;
        ex.section = logterm;
        return ex;
    }
    log.info("[%s] -  %s loaded [%s] from dir(s): ", cmd.name, logterm, Object.keys( trg ), libDirs);
}

