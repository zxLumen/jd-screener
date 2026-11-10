import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLiepinList, parseLinkedinList } from '../lib/sources.js'

const LIEPIN = `
<div class="job-list-item" >
  <div class="job-detail-box">
    <a href="https://www.liepin.com/a/78978943.shtml" data-jobId="78978943">
      <div class="job-title-box">
        <div class="ellipsis-1" title="AI应用工程师">AI应用工程师</div>
        <div class="job-dq-box"><span class="dq-bracket">【</span><span class="ellipsis-1">北京-海淀区</span><span class="dq-bracket">】</span></div>
      </div>
      <span class="job-salary">25-40k·15薪</span>
      <div class="job-labels-box"><span class="labels-tag">3-5年</span><span class="labels-tag">本科</span></div>
    </a>
    <div class="job-detail-company-box"><span class="company-name ellipsis-1">某 AI 公司</span></div>
  </div>
</div>
<div class="job-list-item" >
  <div class="job-detail-box">
    <a href="https://www.liepin.com/a/78978944.shtml" data-jobId="78978944">
      <div class="job-title-box"><div class="ellipsis-1">Python 后端</div><div class="job-dq-box">【上海】</div></div>
      <span class="job-salary">30-50k</span>
    </a>
    <span class="company-name">某金融公司</span>
  </div>
</div>`

test('猎聘列表解析：标题/城市/薪资/公司/链接', () => {
  const items = parseLiepinList(LIEPIN)
  assert.equal(items.length, 2)
  assert.equal(items[0].source, 'liepin')
  assert.equal(items[0].id, '78978943')
  assert.equal(items[0].title, 'AI应用工程师')
  assert.equal(items[0].city, '北京-海淀区')
  assert.equal(items[0].company, '某 AI 公司')
  assert.equal(items[0].url, 'https://www.liepin.com/a/78978943.shtml')
  assert.match(items[0].text, /25-40k·15薪/)
  assert.equal(items[1].id, '78978944')
})

const LINKEDIN = `
<li>
  <div class="base-card">
    <a href="https://www.linkedin.com/jobs/view/ai-engineer-at-foo-4465379983?position=1">
      <h3 class="base-search-card__title"> AI Engineer </h3>
    </a>
    <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://www.linkedin.com/company/foo">Foo Inc</a></h4>
    <span class="job-search-card__location">Beijing, Beijing, China</span>
    <time datetime="2026-11-08">2026-11-08</time>
    <div data-entity-urn="urn:li:jobPosting:4465379983"></div>
  </div>
</li>
<li>
  <div class="base-card">
    <h3 class="base-search-card__title">Backend Engineer</h3>
    <h4 class="base-search-card__subtitle">Bar Ltd</h4>
    <span class="job-search-card__location">Shanghai, China</span>
    <div data-entity-urn="urn:li:jobPosting:4465379984"></div>
  </div>
</li>`

test('LinkedIn 列表解析：id/公司/地点/日期', () => {
  const items = parseLinkedinList(LINKEDIN)
  assert.equal(items.length, 2)
  assert.equal(items[0].id, '4465379983')
  assert.equal(items[0].title, 'AI Engineer')
  assert.equal(items[0].company, 'Foo Inc')
  assert.equal(items[0].city, 'Beijing')
  assert.equal(items[0].postedAt, '2026-11-08')
  assert.equal(items[0].url, 'https://www.linkedin.com/jobs/view/ai-engineer-at-foo-4465379983')
  assert.equal(items[1].city, 'Shanghai')
})
