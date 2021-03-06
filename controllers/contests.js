const Contest = require('../models/Contest')
const Problem = require('../models/Problem')
const Solution = require('../models/Solution')
const Ids = require('../models/ID')
const { extractPagination, isUndefined, isAdmin } = require('../utils')
const only = require('only')

/** 用于检查 url 中 cid 的合法性 */
async function validateCid (cid, ctx, next) {
  if (isNaN(+cid)) {
    ctx.throw(400, 'Contest id (cid) should be a number')
  }
  const contest = await Contest.findOne({cid}).exec()

  if (!contest) {
    ctx.throw(400, 'No such a contest')
  }
  ctx.contest = contest
  return next()
}

/** 返回比赛列表 */
async function queryList (ctx, next) {
  const filter = {} // 用于 mongoose 的筛选

  if (ctx.query.field) {
    // https://docs.mongodb.com/manual/reference/operator/query/where/
    // field 一般为 cid 或 title
    // ctx.query.query 表示搜获的内容
    // 使用 string 而不是 function 是因为，这里的 function 是不能访问到外部变量的
    // 用模板字符串生成筛选条件
    // 正则可以匹配更多的内容
    filter.$where =
      `${new RegExp(ctx.query.query, 'i')}.test(this["${ctx.query.field}"])`
  }

  if (!isAdmin(ctx.session.user)) {
    filter['status'] = ctx.config.status.Available
  }

  const res = await Contest
    .paginate(filter, {
      limit: +ctx.query.limit || 30, // 加号表示使其变为数字
      page: +ctx.query.page || 1,
      sort: {cid: -1},
      // '-_id' 结果不包含 _id
      // http://stackoverflow.com/questions/9598505/mongoose-retrieving-data-without-id-field
      select: '-_id title cid start end status encrypt'
    })

  ctx.body = {
    contests: res.docs,
    pagination: extractPagination(res)
  }
}

/** 指定cid, 返回一个比赛的具体信息 */
async function queryOneContest (ctx, next) {
  const cid = +ctx.params.cid // 之前(validateCid)已经保证这是一个数字了
  const contest = ctx.contest
  ctx.body = {
    contest: only(contest,
      // argument 有时候可能是密码，因此这里根据权限返回不返回
      `cid title encrypt start end list status ${isAdmin(ctx.session.user) ? 'argument' : ''}`)
  }

  if (isAdmin(ctx.session.user)) {
    return
  }
  // 接下来的验证用于 非 admin
  // 尚未验证此比赛
  if (contest.encrypt !== ctx.config.encrypt.Public &&
    ctx.session.user.verifiedContests.indexOf(cid) === -1) {
    ctx.throw(400, contest.encrypt === ctx.config.encrypt.Password
      ? 'You need to input a password to visit this contest'
      : 'You are not invited to attend this contest')
  }
  if (contest.start > Date.now()) {
    ctx.throw(400, 'This contest is still on scheduled')
  }
}

/**
  创建新的比赛
  Caveat:
    传 post 参数的时候，对应数字的字段显示的其实为 string 类型，比如 start，理应 int，
    但从 ctx.request.body 拿出来时为字符串
    即时如此，mongoose 会自动转换，但你作其它事时可能需要注意
*/
async function create (ctx, next) {
  // 必须的字段
  ;['title', 'start', 'end', 'list', 'encrypt'].forEach((item) => {
    if (isUndefined(ctx.request.body[item]) || ctx.request.body[item] === '') {
      ctx.throw(400, `Field "${item}" is required to create a contest`)
    }
  })

  ctx.request.body.start = new Date(ctx.request.body.start).getTime()
  ctx.request.body.end = new Date(ctx.request.body.end).getTime()

  const verified = Contest.validate(ctx.request.body)
  if (!verified.valid) {
    ctx.throw(400, verified.error)
  }

  const cid = await Ids.generateId('Contest')
  const { title, start, end, list, encrypt, argument } = ctx.request.body

  // 检查列表里的题是否都存在
  const ps = await Promise.all(
    list.map((pid) => Problem.findOne({pid}).exec())
  )

  if (ps.some(x => !x)) { // 这道题没找到，说明没这题
    const index = ps.find((item) => !item)
    ctx.throw(400, `Problem ${list[index]} not found`)
  }

  const contest = new Contest({
    cid, title, start, end, list, encrypt, argument, creator: ctx.session.user.uid
  })

  await contest.save()

  ctx.body = {
    contest: only(contest, 'cid title start end list encrypt argument')
  }
}

async function update (ctx, next) {
  const contest = ctx.contest

  const verified = Contest.validate(ctx.request.body)
  if (!verified.valid) {
    ctx.throw(400, verified.error)
  }

  if (ctx.request.body['list']) {
    // 检查列表里的题是否都存在
    const ps = await Promise.all(
      ctx.request.body['list'].map((pid) => Problem.findOne({pid}).exec())
    )

    for (let i = 0; i < ps.length; i += 1) {
      if (!ps[i]) { // 这道题没找到，说明没这题
        ctx.throw(400, `Problem ${ctx.request.body['list'][i]} not found`)
      }
    }
  }

  ;['start', 'end'].forEach((item) => {
    if (!isUndefined(ctx.request.body[item])) {
      ctx.request.body[item] = new Date(ctx.request.body[item]).getTime()
    }
  })

  ;['title', 'start', 'end', 'list', 'encrypt', 'argument', 'status'].forEach((item) => {
    if (!isUndefined(ctx.request.body[item])) {
      contest[item] = ctx.request.body[item]
    }
  })

  await contest.save()
  // 建议更新，以前的记录(overview, ranklist)需要更新
  await Promise.all([ contest.clearOverview(), contest.clearRanklist() ])

  ctx.body = {
    contest: only(contest, 'cid title start end list status')
  }
}

async function del (ctx, next) {
  const cid = +ctx.params.cid
  const contest = ctx.contest

  if (!contest) {
    ctx.throw(400, 'No such a contest')
  }

  await Contest.findOneAndRemove({cid}).exec()

  ctx.body = {}
}

async function overview (ctx, next) {
  const contest = ctx.contest

  const overview = await contest.fetchOverview()

  const filters = ctx.session.user ? { uid: ctx.session.user.uid } : {}

  const solved = await Solution
    .find(Object.assign(filters, {
      mid: contest.cid,
      judge: ctx.config.judge.Accepted,
      module: ctx.config.module.Contest
    }))
    .distinct('pid')
    .exec()

  ctx.body = {
    overview,
    solved
  }
}

async function ranklist (ctx, next) {
  const contest = ctx.contest

  const ranklist = await contest.fetchRanklist()

  ctx.body = {
    ranklist
  }
}

// 验证有没有被邀请或输入正确密码
async function verifyArgument (ctx, next) {
  ctx.body = {}
  if (isAdmin(ctx.session.user)) {
    // admin 无需检查
    return
  }
  const cid = +ctx.params.cid
  const contest = ctx.contest
  if (ctx.session.user.verifiedContests.indexOf(cid) !== -1) {
    return // 已经验证过了
  }

  if (contest.encrypt === ctx.config.encrypt.Password) {
    if (contest.argument !== ctx.request.body.argument) {
      ctx.throw(400, 'Wrong password')
    }
  }

  if (contest.encrypt === ctx.config.encrypt.Private) {
    const argument = ctx.request.body.argument
    const regexp = new RegExp(`\b${ctx.session.user.uid}\b`, 'g')
    if (!regexp.test(argument)) {
      ctx.throw(400, "You're not invited to attend this contest")
    }
  }
  ctx.session.user.verifiedContests.push(cid)
}

module.exports = {
  queryList,
  queryOneContest,
  create,
  update,
  del,
  overview,
  ranklist,
  verifyArgument,
  validateCid
}
