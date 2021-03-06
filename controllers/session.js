const User = require('../models/User')
const { generatePwd } = require('../utils')
const only = require('only')

/**
  登录
*/
async function login (ctx, next) {
  if (ctx.session.user) {
    ctx.throw(400, 'You have logined')
  }

  const { uid, pwd } = ctx.request.body
  const user = await User.findOne({uid}).exec()

  if (!user) {
    ctx.throw(400, 'No such a user')
  }
  if (user.pwd !== generatePwd(pwd)) {
    ctx.throw(400, 'Wrong password')
  }

  user.updateRecords(ctx.ip, Date.now())
  await user.save()

  ctx.session.user = only(user, 'uid nick privilege')
  ctx.session.user.verifiedContests = [] // 验证过的比赛
  ctx.session.user.language = ctx.config.language.Cpp // 默认选择的语言
  ctx.body = { user: ctx.session.user }
}

/**
  登出
*/
async function logout (ctx, next) {
  if (ctx.session.user) {
    ctx.session = null
  }
  ctx.body = {}
}

/**
  检查当前登录状态
*/
async function fetchSession (ctx, next) {
  ctx.body = ctx.session.user ? {
    user: ctx.session.user
  } : {}
}

module.exports = {
  login,
  logout,
  fetchSession
}
