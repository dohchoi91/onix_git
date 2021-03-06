var LocalStrategy = require('passport-local').Strategy;
var FacebookTokenStrategy = require('passport-facebook-token');
var bcrypt = require('bcrypt');
var async = require('async');
var hexkey = process.env.FMS_SERVER_KEY;
var authConfig = require('./authconfig');

var winston = require('winston');
var winstonconfig = require('./winstonconfig');
var logging = new winston.Logger(winstonconfig);


module.exports = function (passport) {

  passport.serializeUser(function (user, done) {
    done(null, user);
  });

  passport.deserializeUser(function (user, done) { //요청이 있을 때마다 세션에서 id를 가져온다.
    pool.getConnection(function (err, connection) {
      if (err) {
        done(err);
      } else {
        if (user.user_type === 1) {
          var sql = "select id, convert(aes_decrypt(email_id, unhex(" + connection.escape(hexkey) + ")) using utf8) as email_id " +
            "        from customer " +
            "        where id = ? ";

        } else if (user.user_type === 2) {
          var sql = "select id, convert(aes_decrypt(email_id, unhex(" + connection.escape(hexkey) + ")) using utf8) as email_id, " +
            "               nickname " +
            "        from artist " +
            "        where id = ?";
        } else if (user.user_type === 3) {
          var sql = "select id, facebook_email as email_id " +
            "        from customer " +
            "        where id = ?";
        }
        connection.query(sql, [user.id], function (err, results) {
          connection.release(); //주의!!!
          if (err) {
            done(err);
          } else {
            var user = {
              "id": results[0].id,
              "email_id": results[0].email_id,
              "nickname": results[0].nickname
            };
            done(null, user);
          }
        });
      }
    });
  });

  passport.use('local-login', new LocalStrategy({ // 로그인할 때 사용하겠다
    usernameField: "email_id",//email을 id로 사용
    passwordField: "password",
    passReqToCallback: true //false일 경우 다음 함수의 req를 받지 않는다.
  }, function (req, email_id, password, done) {

    logging.log('info', 'email_id : '+email_id);
    logging.log('info', 'pushToken : '+req.body.registration_token);

    function getConnection(callback) {
      //pool에서 connection 얻어오기.
      pool.getConnection(function (err, connection) {
        if (err) {
          callback(err);
        } else {
          callback(null, connection);
        }
      });
    }

    function selectUser(connection, callback) {
      var user_type = parseInt(req.body.user_type);

      if (user_type === 1) {
        var sql = "SELECT id, email_id, password " +
          "        FROM customer " +
          "        WHERE email_id = aes_encrypt(" + connection.escape(email_id) + ",unhex(" + connection.escape(hexkey) + "))";
      } else if (user_type === 2) {
        var sql = "SELECT id, email_id, password " +
          "        FROM artist " +
          "        WHERE email_id = aes_encrypt(" + connection.escape(email_id) + ",unhex(" + connection.escape(hexkey) + "))";
      } else {
        connection.release();
        var err = new Error("사용자가 존재하지 않습니다...");
        err.statusCode = -104;
        callback(err);
      }

      connection.query(sql, function (err, results) {
        if (err) {
          connection.release();
          callback(err);
        } else {
          if (results.length === 0) {
            connection.release();
            var err = new Error('사용자가 존재하지 않습니다...');
            err.statusCode = -104;
            callback(err); // callback(null, false)로 해도 됨
          } else {
            var user = {
              "id": results[0].id,
              "user_type": user_type,
              "hashPassword": results[0].password
            };
            callback(null, user, connection);
          }
        }
      });
    }

    function compareUserInput(user, connection, callback) {
      bcrypt.compare(password, user.hashPassword, function (err, result) { // 해시 전 패스워드 다음에 해시 후 패스워드가 와야 한다. 순서 중요
        if (err) {
          connection.release();
          callback(err);
        } else {
          if (result) { //true
            //유저일 경우 푸시토큰 처리
            if (user.user_type === 1) {
              var updateTokenSql = "update customer set registration_token = ? " +
                "where id = ? ";
              connection.query(updateTokenSql, [req.body.registration_token, user.id], function (err) {
                connection.release();
                if (err) {
                  callback(err);
                } else {
                  callback(null, user);
                }
              });
            } else {
              connection.release();
              callback(null, user);
            }
          } else { //false
            connection.release();
            callback(null, false); //비밀번호가 틀렸을 때
          }
        }
      });
    }

    // task 수행 간 결과를 입력으로 전달하는 구조를 지원
    async.waterfall([getConnection, selectUser, compareUserInput], function (err, user) {
      if (err) {
        done(err);
      } else {
        //user 객체에서 password와 hash를 빼서 보내줘야 한다. 보안상 문제가 되기 때문에
        delete user.hashPassword;
        done(null, user);
      }
    });
  }));

  passport.use('facebook-token', new FacebookTokenStrategy({
    "clientID": authConfig.facebook.appId,
    "clientSecret": authConfig.facebook.appSecret,
    "profileFields": ["id", "email"],
     passReqToCallback : true
  }, function (req, accessToken, refreshToken, profile, done) {

    logging.log('info', 'pushToken : '+req.body.registration_token);
    logging.log('info', 'accessToken : '+accessToken);
    logging.log('info', 'facebook_id : '+profile.id);
    logging.log('info', 'facebook_email : '+profile.emails[0].value);

    function getConnection(callback) {
      pool.getConnection(function (err, connection) {
        if (err) {
          callback(err);
        } else {
          callback(null, connection);
        }
      });
    }

    function selectOrCreateUser(connection, callback) {
      // DB에서 username과 관련딘 id와 password를 조회하는 쿼리를 작성한다.
      var sql = "SELECT id, facebook_id, facebook_email, facebook_token " +
        "        FROM customer " +
        "        WHERE facebook_id = ?";
      connection.query(sql, [profile.id], function (err, results) {
        if (err) {
          connection.release();
          callback(err);
        } else {
          if (results.length === 0) { // 쿼리 결과 일치하는 사용자가 없을 때 INSERT 한다.

            //페이스북 아이디와 푸시토큰 insert
            var insert = "INSERT INTO customer (facebook_id, facebook_token, facebook_email, registration_token) " +
              "           VALUES (?,?,?,?)";

            connection.query(insert, [profile.id, accessToken, profile.emails[0].value, req.body.registration_token], function (err, result) {
              if (err) {
                connection.release();
                callback(err);
              } else {
                var user = {
                  "id": result.insertId,
                  "email_id": profile.emails[0].value,
                  "user_type": 3
                };
                callback(null, user);
              }
            });
          } else { //일치하는 사용자가 있으면 facebook_token을 업데이트할지 결정
            if (accessToken === results[0].facebook_token) { //같으면 업데이트하지 않고 user 객체에 담아 넘겨준다.
              // 푸시토큰 업데이트
              var updatePushTokenSql = "UPDATE customer " +
                "                       SET  registration_token= ? " +
                "                       WHERE facebook_id = ?";
              connection.query(updatePushTokenSql, [req.body.registration_token, profile.id], function (err) {
                connection.release();
                if (err) {
                  callback(err);
                } else {
                  var user = {
                    "id": results[0].id,
                    "email_id": results[0].facebook_email,
                    "user_type": 3
                  };
                  callback(null, user);
                }
              });
            } else {

              //페이스북 토큰, 푸시토큰 업데이트
              var updateFacebookSql = "UPDATE customer " +
                "                      SET facebook_token = ?, " +
                "                          facebook_email = ?, " +
                "                          registration_token= ? " +
                "                      WHERE facebook_id = ?";

              connection.query(updateFacebookSql, [accessToken, profile.emails[0].value, req.body.registration_token, profile.id], function (err) {
                connection.release();
                if (err) {
                  callback(err);
                } else {
                  var user = {
                    "id": results[0].id,
                    "email_id": profile.emails[0].value,
                    "user_type": 3
                  };
                  callback(null, user);
                }
              });
            }
          }
        }
      });
    }

    async.waterfall([getConnection, selectOrCreateUser], function (err, user) {
      if (err) {
        done(err);
      } else {
        done(null, user);
      }
    });

  }));

};
