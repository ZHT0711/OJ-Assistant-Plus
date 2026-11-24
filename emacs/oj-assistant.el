;;; oj-assistant.el --- Native OJ workspace for Emacs -*- lexical-binding: t; coding: utf-8; -*-

;; Version: 0.1.0
;; Package-Requires: ((emacs "28.1"))
;; Keywords: tools, languages
;; SPDX-License-Identifier: MIT

;;; Commentary:
;; Native problem browser, statement side window and asynchronous local tests.
;; Uses the adjacent Node service and the OJ Assistant checkout's platform code.
;; Entry point: M-x oj-assistant.  See README.md for commands and configuration.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'subr-x)
(require 'tabulated-list)
(require 'button)
(require 'shr)

(defgroup oj-assistant nil "Online judge practice." :group 'tools)
(defconst oj-assistant--directory
  (file-name-directory (or load-file-name buffer-file-name))
  "Directory containing the Emacs package and its Node service.")
(defcustom oj-assistant-node-command "node"
  "Node.js executable, as a name on PATH or a full path."
  :type 'string)
(defcustom oj-assistant-default-directory (expand-file-name "OJ/" "~")
  "Default directory offered when opening a practice workspace."
  :type 'directory)
(defcustom oj-assistant-default-language "cpp"
  "Language for new solutions. Existing practice problems remember their language."
  :type '(choice (const "cpp") (const "c") (const "py") (const "js")
                 (const "java") (const "go") (const "rs")))
(defcustom oj-assistant-time-limit 2
  "Time limit in seconds for each local test."
  :type 'number)
(defcustom oj-assistant-tools nil
  "Alist of tool symbols and executable paths, without shell quotes.
Keys are cpp, c, python, node, javac, java, go and rust."
  :type '(alist :key-type symbol :value-type string))
(defcustom oj-assistant-statement-width 0.42
  "Width of the statement side window, as a fraction of the frame."
  :type 'number)

(defconst oj-assistant--languages
  '(("C++ 17" . "cpp") ("C 11" . "c") ("Python 3" . "py")
    ("JavaScript" . "js") ("Java (Main)" . "java") ("Go" . "go") ("Rust 2021" . "rs")))
(defconst oj-assistant--platforms
  '("luogu" "leetcode" "neuoj" "csecg" "hnuacm" "hnucg" "hdoj" "codeforces" "fjutacm"))
(defvar oj-assistant--process nil)
(defvar oj-assistant--sequence 0)
(defvar oj-assistant--requests (make-hash-table :test #'eql))
(defvar oj-assistant--last-root nil)
(defvar oj-assistant--language-preferences (make-hash-table :test #'equal))
(defvar-local oj-assistant-root nil)
(defvar-local oj-assistant-problem nil)
(defvar-local oj-assistant-source nil)
(defvar-local oj-assistant--kind 'practice)
(defvar-local oj-assistant--keyword "")
(defvar-local oj-assistant--page 1)
(defvar-local oj-assistant--has-more nil)
(defvar-local oj-assistant--rows nil)
(defvar-local oj-assistant--revision 0)
(defvar-local oj-assistant--test-context nil)

(defun oj-assistant--get (key object) (alist-get key object))
(defun oj-assistant--json (value)
  (let ((encoded (json-serialize value :null-object nil :false-object :false)))
    (if (multibyte-string-p encoded) encoded (decode-coding-string encoded 'utf-8))))
(defun oj-assistant--parse (value)
  (json-parse-string value :object-type 'alist :array-type 'list :null-object nil :false-object nil))

(defun oj-assistant--error (message-text)
  (message "OJ Assistant · %s" message-text))

(defun oj-assistant--sentinel (process event)
  (unless (process-live-p process)
    (when (eq process oj-assistant--process)
      (setq oj-assistant--process nil)
      (let ((requests oj-assistant--requests))
        (setq oj-assistant--requests (make-hash-table :test #'eql))
        (maphash (lambda (_ callbacks)
                   (funcall (cdr callbacks) (concat "后台服务已退出，请重试。" (string-trim event))))
                 requests)))))

(defun oj-assistant--deliver (packet)
  (let ((id (oj-assistant--get 'id packet)))
    (if id
        (when-let* ((callbacks (gethash id oj-assistant--requests)))
          (remhash id oj-assistant--requests)
          (if-let* ((error-text (oj-assistant--get 'error packet)))
              (funcall (cdr callbacks) error-text)
            (funcall (car callbacks) (oj-assistant--get 'result packet))))
      (pcase (oj-assistant--get 'event packet)
        ("progress" (message "OJ Assistant · %s" (oj-assistant--get 'message packet)))
        ("open" (browse-url (oj-assistant--get 'url packet)))
        ("judgement"
         (let* ((record (oj-assistant--get 'record packet))
                (verdict (oj-assistant--get 'verdict record)))
           (message "OJ · %s · %s" (oj-assistant--get 'problemId record)
                    (or (oj-assistant--get 'result verdict) (oj-assistant--get 'state record)))))))))

(defun oj-assistant--filter (process chunk)
  (let* ((text (concat (or (process-get process 'partial) "") chunk))
         (lines (split-string text "\n")))
    (process-put process 'partial (car (last lines)))
    (dolist (line (butlast lines))
      (unless (string-empty-p line)
        (condition-case err
            (run-at-time 0 nil #'oj-assistant--deliver (oj-assistant--parse line))
          (error (oj-assistant--error (format "服务响应解析失败 %s" (error-message-string err)))))))))

(defun oj-assistant--start ()
  (unless (process-live-p oj-assistant--process)
    (let ((bridge (expand-file-name "bridge.cjs" oj-assistant--directory))
          (node (executable-find oj-assistant-node-command)))
      (unless node (user-error "找不到 Node.js，请设置 oj-assistant-node-command"))
      (unless (file-readable-p bridge) (user-error "找不到后台服务 %s" bridge))
      (setq oj-assistant--process
            (make-process :name "oj-assistant" :command (list node bridge)
                          :buffer nil :stderr (get-buffer-create " *oj-assistant-service*")
                          :connection-type 'pipe :coding 'utf-8-unix :noquery t
                          :filter #'oj-assistant--filter :sentinel #'oj-assistant--sentinel)))))

(defun oj-assistant--rpc (method params callback &optional error-callback)
  (oj-assistant--start)
  (let ((id (cl-incf oj-assistant--sequence)))
    (puthash id (cons callback (or error-callback #'oj-assistant--error)) oj-assistant--requests)
    (condition-case err
        (process-send-string oj-assistant--process
                             (concat (oj-assistant--json `((id . ,id) (method . ,method) (params . ,params))) "\n"))
      (error
       (remhash id oj-assistant--requests)
       (funcall (or error-callback #'oj-assistant--error) (error-message-string err))))))

(defun oj-assistant--root ()
  (file-name-as-directory
   (expand-file-name
    (or oj-assistant-root
        (locate-dominating-file default-directory ".oj-assistant")
        (locate-dominating-file default-directory ".ojassistconfig.json")
        oj-assistant--last-root
        (user-error "请先用 M-x oj-assistant 打开刷题目录")))))

(defun oj-assistant--name (label root)
  (format "*OJ %s · %s · %s*" label (file-name-nondirectory (directory-file-name root))
          (substring (secure-hash 'sha1 root) 0 6)))

(defun oj-assistant--params (&optional root problem)
  `((root . ,(or root (oj-assistant--root)))
    (key . ,(oj-assistant--get 'key (or problem oj-assistant-problem)))
    (kind . ,(if (equal (oj-assistant--get 'kind (or problem oj-assistant-problem)) "account") "account" "practice"))))

(defvar oj-assistant-list-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (dolist (binding '(("RET" . oj-assistant-open-problem) ("g" . oj-assistant-refresh)
                       ("a" . oj-assistant-account-library) ("p" . oj-assistant-practice-library)
                       ("i" . oj-assistant-import-url) ("I" . oj-assistant-import-json)
                       ("n" . oj-assistant-init-workspace) ("l" . oj-assistant-login)
                       ("A" . oj-assistant-use-account) ("s" . oj-assistant-search)
                       ("o" . oj-assistant-browse) ("L" . oj-assistant-select-language)
                       (">" . oj-assistant-next-page) ("h" . oj-assistant-history)
                       ("d" . oj-assistant-remove) ("f" . oj-assistant-open-id)))
      (define-key map (kbd (car binding)) (cdr binding)))
    map))

(define-derived-mode oj-assistant-list-mode tabulated-list-mode "OJ Assistant"
  "Problem library. RET opens a solution and its statement side by side."
  (setq tabulated-list-format [("分组 / 平台" 24 t) ("题号" 12 t) ("题目" 44 t)
                               ("完成 / 难度" 24 t) ("截止" 22 t)]
        tabulated-list-padding 2)
  (tabulated-list-init-header)
  (setq-local revert-buffer-function (lambda (&rest _) (oj-assistant-refresh))))

;;;###autoload
(defun oj-assistant (&optional directory)
  "Open DIRECTORY as an OJ workspace. With a prefix, choose another directory."
  (interactive
   (list (when current-prefix-arg
           (read-directory-name "刷题目录 " (or oj-assistant--last-root oj-assistant-default-directory)))))
  (let* ((root (file-name-as-directory (expand-file-name
                                      (or directory oj-assistant-root
                                          (locate-dominating-file default-directory ".oj-assistant")
                                          (locate-dominating-file default-directory ".ojassistconfig.json")
                                          oj-assistant--last-root
                                          (read-directory-name "刷题目录 " oj-assistant-default-directory)))))
         (buffer (get-buffer-create (oj-assistant--name "题库" root))))
    (make-directory (expand-file-name ".oj-assistant" root) t)
    (setq oj-assistant--last-root root)
    (with-current-buffer buffer
      (unless (derived-mode-p 'oj-assistant-list-mode) (oj-assistant-list-mode))
      (setq-local oj-assistant-root root default-directory root)
      (setq-local header-line-format
                  " RET 做题  a 账号题库  p 链接题库  i 导入链接  I 导入JSON  l 登录  s 搜索  L 语言  h 历史"))
    (when (window-dedicated-p)
      (when-let* ((window (get-mru-window))) (select-window window)))
    (switch-to-buffer buffer)
    (oj-assistant-refresh)))

(defun oj-assistant--row-id (row)
  (or (oj-assistant--get 'key row)
      (format "%s/%s" (or (oj-assistant--get 'contestId row) "") (oj-assistant--get 'id row))))

(defun oj-assistant--render-library ()
  (let ((rows (if (and (eq oj-assistant--kind 'practice) (not (string-empty-p oj-assistant--keyword)))
                  (cl-remove-if-not
                   (lambda (row) (string-match-p (regexp-quote oj-assistant--keyword)
                                                 (format "%s %s" (oj-assistant--get 'title row) (oj-assistant--get 'group row))))
                   oj-assistant--rows)
                oj-assistant--rows)))
    (setq tabulated-list-entries
          (mapcar (lambda (row)
                    (list (oj-assistant--row-id row)
                          (vector (or (oj-assistant--get 'assignmentName row) (oj-assistant--get 'group row)
                                      (oj-assistant--get 'platform row) "")
                                  (or (oj-assistant--get 'id row) (substring (oj-assistant--get 'key row) 0 8))
                                  (or (oj-assistant--get 'title row) "")
                                  (string-join (delq nil (list (oj-assistant--get 'status row)
                                                              (oj-assistant--get 'difficulty row)
                                                              (when (oj-assistant--get 'late row) "补交中"))) " ")
                                  (or (oj-assistant--get 'deadline row) "")))) rows))
    (tabulated-list-print t)
    (setq mode-name (format "OJ %s · %d 题%s" (if (eq oj-assistant--kind 'account) "账号" "链接")
                            (length rows) (if oj-assistant--has-more " · > 下一页" "")))))

(defun oj-assistant-refresh (&optional append-page)
  "Reload the visible library. APPEND-PAGE retains earlier account pages."
  (interactive)
  (unless (derived-mode-p 'oj-assistant-list-mode)
    (user-error "请在题库窗口刷新"))
  (let* ((buffer (current-buffer)) (root oj-assistant-root)
         (revision (cl-incf oj-assistant--revision))
         (kind oj-assistant--kind))
    (unless append-page (setq oj-assistant--page 1))
    (message "OJ Assistant · 正在加载题库…")
    (oj-assistant--rpc
     (if (eq kind 'account) "account-list" "practice-list")
     `((root . ,root) (keyword . ,oj-assistant--keyword) (page . ,oj-assistant--page))
     (lambda (result)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (when (= revision oj-assistant--revision)
             (setq oj-assistant--has-more (and (eq kind 'account) (oj-assistant--get 'hasMore result))
                   oj-assistant--rows (if append-page
                                          (cl-remove-duplicates
                                           (append oj-assistant--rows (oj-assistant--get 'problems result))
                                           :test #'equal :key #'oj-assistant--row-id)
                                        (if (eq kind 'account) (oj-assistant--get 'problems result) result)))
             (oj-assistant--render-library)
             (message "OJ Assistant · 已加载 %d 题" (length oj-assistant--rows)))))))))

(defun oj-assistant-account-library ()
  "Show the logged-in platform's problem library."
  (interactive)
  (unless (derived-mode-p 'oj-assistant-list-mode) (oj-assistant (oj-assistant--root)))
  (setq oj-assistant--kind 'account oj-assistant--keyword "")
  (oj-assistant-refresh))

(defun oj-assistant-practice-library ()
  "Show cached link practice problems."
  (interactive)
  (unless (derived-mode-p 'oj-assistant-list-mode) (oj-assistant (oj-assistant--root)))
  (setq oj-assistant--kind 'practice oj-assistant--keyword "")
  (oj-assistant-refresh))

(defun oj-assistant-next-page ()
  "Append the next page of platform problems."
  (interactive)
  (unless oj-assistant--has-more (user-error "已经是最后一页"))
  (cl-incf oj-assistant--page)
  (oj-assistant-refresh t))

(defun oj-assistant-search (keyword)
  "Search the current library for KEYWORD. An empty string resets it."
  (interactive (list (read-string "搜索题目 " oj-assistant--keyword)))
  (setq oj-assistant--keyword keyword)
  (oj-assistant-refresh))

(defun oj-assistant--current-row ()
  (let ((id (tabulated-list-get-id)))
    (or (cl-find id oj-assistant--rows :key #'oj-assistant--row-id :test #'equal)
        (user-error "请把光标移到一道题上"))))

(defun oj-assistant--language ()
  (or (gethash (oj-assistant--root) oj-assistant--language-preferences) oj-assistant-default-language))

(defun oj-assistant--open-result (root result)
  (let ((source (oj-assistant--get 'source result))
        (problem (oj-assistant--get 'problem result)))
    (when (window-dedicated-p)
      (when-let* ((window (get-mru-window))) (select-window window)))
    (find-file source)
    (setq-local oj-assistant-root root oj-assistant-problem problem oj-assistant-source source)
    (oj-assistant-mode 1)
    (oj-assistant--statement root problem source)))

(defun oj-assistant-open-problem ()
  "Open the problem under point, preserving every existing solution."
  (interactive)
  (let* ((row (oj-assistant--current-row)) (root oj-assistant-root)
         (account (eq oj-assistant--kind 'account))
         (params (append `((root . ,root))
                         (if account
                             `((id . ,(oj-assistant--get 'id row))
                               (contestId . ,(oj-assistant--get 'contestId row))
                               (assignmentName . ,(oj-assistant--get 'assignmentName row))
                               (language . ,(oj-assistant--language)))
                           `((key . ,(oj-assistant--get 'key row)))))))
    (oj-assistant--rpc (if account "account-open" "practice-open") params
                       (lambda (result) (oj-assistant--open-result root result)))))

(defun oj-assistant-open-id (id &optional contest)
  "Open account problem ID, optionally in CONTEST or assignment."
  (interactive (list (read-string "平台题号 ") (read-string "比赛 / 作业 ID（可留空） ")))
  (let ((root (oj-assistant--root)))
    (oj-assistant--rpc "account-open"
                       `((root . ,root) (id . ,id) (contestId . ,(unless (string-empty-p (or contest "")) contest))
                         (language . ,(oj-assistant--language)))
                       (lambda (result) (oj-assistant--open-result root result)))))

(defvar oj-assistant-statement-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "r") #'oj-assistant-run-tests)
    (define-key map (kbd "t") #'oj-assistant-edit-tests)
    (define-key map (kbd "s") #'oj-assistant-submit)
    (define-key map (kbd "o") #'oj-assistant-browse)
    (define-key map (kbd "L") #'oj-assistant-select-language)
    map))

(define-derived-mode oj-assistant-statement-mode special-mode "OJ 题面"
  "Rendered statement and sample tests. r runs, t edits tests, s submits.")

(defun oj-assistant--statement (root problem source)
  (let ((buffer (get-buffer-create (oj-assistant--name "题面" root))))
    (with-current-buffer buffer
      (oj-assistant-statement-mode)
      (setq-local oj-assistant-root root oj-assistant-problem problem oj-assistant-source source
                  default-directory root)
      (let ((inhibit-read-only t)
            (shr-inhibit-images t) (shr-use-fonts nil) (shr-width 78))
        (erase-buffer)
        (insert (propertize (or (oj-assistant--get 'title problem) "题面") 'face 'bold) "\n\n")
        (dolist (action '(("运行样例" . oj-assistant-run-tests) ("编辑测试" . oj-assistant-edit-tests)
                          ("提交" . oj-assistant-submit) ("原题网页" . oj-assistant-browse)
                          ("切换语言" . oj-assistant-select-language)))
          (insert-text-button (car action) 'follow-link t
                              'action (let ((command (cdr action))) (lambda (_) (call-interactively command))))
          (insert "  "))
        (insert "\n\n")
        (let ((html (oj-assistant--get 'statement problem)))
          (if (fboundp 'libxml-parse-html-region)
              (let ((dom (with-temp-buffer
                           (insert (or html ""))
                           (libxml-parse-html-region (point-min) (point-max)))))
                (when dom (shr-insert-document dom)))
            (insert (or html ""))))
        (cl-loop for sample in (oj-assistant--get 'samples problem) for index from 1 do
                 (insert (format "\n── 样例 %d ──\n输入\n%s\n输出\n%s\n"
                                 index (oj-assistant--get 'input sample) (oj-assistant--get 'output sample))))
        (goto-char (point-min))))
    (display-buffer-in-side-window buffer `((side . right) (slot . 1) (window-width . ,oj-assistant-statement-width)))))

(defun oj-assistant-show-statement ()
  "Show the cached statement for this solution."
  (interactive)
  (unless oj-assistant-problem (user-error "当前文件尚未关联 OJ 题目"))
  (oj-assistant--statement (oj-assistant--root) oj-assistant-problem oj-assistant-source))

(defun oj-assistant-select-language (language)
  "Select LANGUAGE and open its own solution file for the current problem."
  (interactive (list (cdr (assoc (completing-read "做题语言 " oj-assistant--languages nil t)
                                oj-assistant--languages))))
  (let ((root (oj-assistant--root)) (problem oj-assistant-problem))
    (puthash root language oj-assistant--language-preferences)
    (if problem
        (let ((account (equal (oj-assistant--get 'kind problem) "account")))
          (oj-assistant--rpc
           (if account "account-open" "practice-open")
           (append (oj-assistant--params root problem)
                   `((language . ,language) (id . ,(oj-assistant--get 'id problem))
                     (contestId . ,(oj-assistant--get 'contestId problem))))
           (lambda (result) (oj-assistant--open-result root result))))
      (message "OJ Assistant · 新题默认语言 %s" language))))

(defun oj-assistant--refresh-root (root)
  (when-let* ((buffer (get-buffer (oj-assistant--name "题库" root))))
    (with-current-buffer buffer (oj-assistant-refresh))))

(defun oj-assistant-import-url (url)
  "Import a problem or public contest URL into the current workspace."
  (interactive (list (read-string "题目或比赛链接 " (when (use-region-p)
                                                      (buffer-substring-no-properties (region-beginning) (region-end))))))
  (let ((root (oj-assistant--root)))
    (message "OJ Assistant · 正在导入…")
    (oj-assistant--rpc
     "practice-import" `((root . ,root) (url . ,url))
     (lambda (result)
       (oj-assistant--refresh-root root)
       (let ((failed (oj-assistant--get 'failed result)))
         (message "OJ Assistant · 导入 %d 题，失败 %d 题"
                  (length (oj-assistant--get 'imported result)) (length failed))
         (when failed
           (oj-assistant--output root "导入报告"
                                  (mapconcat (lambda (item) (format "%s\n%s" (oj-assistant--get 'url item)
                                                                    (oj-assistant--get 'message item))) failed "\n\n"))))))))

(defun oj-assistant-import-json (file)
  "Import FILE in Competitive Companion or OJ Assistant JSON format."
  (interactive "f导入题目 JSON ")
  (let ((root (oj-assistant--root)))
    (oj-assistant--rpc "practice-json" `((root . ,root) (file . ,(expand-file-name file)))
                       (lambda (result)
                         (oj-assistant--refresh-root root)
                         (message "OJ Assistant · 已导入 %d 题" (length result))))))

(defun oj-assistant-remove ()
  "Remove a link problem from the list, retaining its solution and tests."
  (interactive)
  (unless (eq oj-assistant--kind 'practice) (user-error "仅链接题库支持移除"))
  (let ((root oj-assistant-root) (row (oj-assistant--current-row)))
    (when (yes-or-no-p (format "从列表移除 %s？代码和测试会保留 " (oj-assistant--get 'title row)))
      (oj-assistant--rpc "practice-remove" `((root . ,root) (key . ,(oj-assistant--get 'key row)))
                         (lambda (_) (oj-assistant--refresh-root root))))))

(defun oj-assistant-init-workspace (backend)
  "Configure the current workspace for BACKEND."
  (interactive (list (completing-read "账号平台 " oj-assistant--platforms nil t)))
  (let ((root (oj-assistant--root)))
    (oj-assistant--rpc "init" `((root . ,root) (backend . ,backend))
                       (lambda (_) (message "OJ Assistant · 已配置 %s，按 l 登录" backend)))))

(defun oj-assistant-login ()
  "Log in through a browser, a pasted Cookie, or username and password."
  (interactive)
  (let* ((root (oj-assistant--root))
         (method (completing-read "登录方式 " '("浏览器登录" "粘贴 Cookie" "用户名密码") nil t))
         (label (read-string "账号名称（用于复用） "))
         (callback (lambda (result)
                     (message "OJ Assistant · %s 已登录%s" (oj-assistant--get 'label result)
                              (if (oj-assistant--get 'persistent result) "，凭据已加密保存" "，凭据保留在本次服务会话")))))
    (if (equal method "浏览器登录")
        (progn
          (message "OJ Assistant · 请在打开的浏览器完成登录，最长等待 5 分钟")
          (oj-assistant--rpc "browser-login" `((root . ,root) (label . ,label)) callback))
      (let ((credentials (if (equal method "粘贴 Cookie")
                             `((cookies . ,(read-passwd "Cookie ")))
                           `((username . ,(read-string "用户名 "))
                             (password . ,(read-passwd "密码 "))))))
        (oj-assistant--rpc "login" `((root . ,root) (label . ,label) (credentials . ,credentials)) callback)))))

(defun oj-assistant-use-account ()
  "Select a saved account and use it in the current workspace."
  (interactive)
  (let ((root (oj-assistant--root)))
    (oj-assistant--rpc
     "accounts" `((root . ,root))
     (lambda (accounts)
       (unless accounts (user-error "尚无保存的账号，请先初始化并登录"))
       (let* ((choices (mapcar (lambda (account)
                                 (cons (format "%s · %s · %s" (oj-assistant--get 'backend account)
                                               (oj-assistant--get 'label account) (oj-assistant--get 'id account)) account)) accounts))
              (account (cdr (assoc (completing-read "使用账号 " choices nil t) choices))))
         (oj-assistant--rpc "account-use" `((root . ,root) (id . ,(oj-assistant--get 'id account)))
                            (lambda (_) (oj-assistant--refresh-root root)
                              (message "OJ Assistant · 已切换账号"))))))))

(defun oj-assistant--source-file ()
  (let ((file (or oj-assistant-source buffer-file-name)))
    (unless (and file oj-assistant-problem) (user-error "请先从 OJ 题库打开一道题"))
    (when-let* ((buffer (find-buffer-visiting file)))
      (with-current-buffer buffer (when (buffer-modified-p) (save-buffer))))
    file))

(defun oj-assistant--output (root label text)
  (let ((buffer (get-buffer-create (oj-assistant--name label root))))
    (with-current-buffer buffer
      (special-mode)
      (setq-local oj-assistant-root root)
      (let ((inhibit-read-only t)) (erase-buffer) (insert text) (goto-char (point-min))))
    (display-buffer buffer)))

(defun oj-assistant-run-tests (&optional choose-driver)
  "Save the solution and run all tests asynchronously.
With CHOOSE-DRIVER (prefix argument), select a self-contained function driver."
  (interactive "P")
  (let* ((source (oj-assistant--source-file)) (root (oj-assistant--root))
         (driver (when choose-driver (read-file-name "自包含测试驱动 " (file-name-directory source) nil t)))
         (params (append (oj-assistant--params)
                         `((source . ,source) (driver . ,driver) (tools . ,oj-assistant-tools)
                           (timeout . ,(round (* 1000 oj-assistant-time-limit)))))))
    (when driver
      (when-let* ((buffer (find-buffer-visiting driver)))
        (with-current-buffer buffer (when (buffer-modified-p) (save-buffer)))))
    (message "OJ Assistant · 编译 / 测试中…")
    (oj-assistant--rpc
     "run" params
     (lambda (results)
       (oj-assistant--output
        root "测试结果"
        (concat (format "%s\n%d / %d 通过\n\n" source
                        (cl-count-if (lambda (result) (oj-assistant--get 'passed result)) results) (length results))
                (mapconcat
                 (lambda (entry)
                   (let* ((index (car entry)) (result (cdr entry))
                          (status (cond ((oj-assistant--get 'timedOut result) "TLE")
                                        ((oj-assistant--get 'overflow result) "OLE")
                                        ((oj-assistant--get 'passed result) "AC")
                                        ((not (eq (oj-assistant--get 'code result) 0)) "RE") (t "WA"))))
                     (format "样例 %d  %s  %s ms\n输入\n%s\n预期输出\n%s\n实际输出\n%s\n标准错误\n%s\n"
                             index status (oj-assistant--get 'elapsed result)
                             (oj-assistant--get 'input result) (oj-assistant--get 'expected result)
                             (oj-assistant--get 'stdout result) (oj-assistant--get 'stderr result))))
                 (cl-loop for result in results for index from 1 collect (cons index result)) "\n"))))
     (lambda (error-text) (oj-assistant--output root "测试结果" error-text)))))

(defun oj-assistant-edit-tests ()
  "Edit shared samples/custom tests as a JSON array. Save with C-c C-c."
  (interactive)
  (unless oj-assistant-problem (user-error "请先打开一道题"))
  (let ((root (oj-assistant--root)) (problem oj-assistant-problem)
        (params (oj-assistant--params)))
    (oj-assistant--rpc
     "tests" params
     (lambda (tests)
       (let ((buffer (get-buffer-create
                      (format "*OJ 测试 · %s · %s*" (oj-assistant--get 'key problem) (substring (secure-hash 'sha1 root) 0 6)))))
         (with-current-buffer buffer
           (unless (buffer-modified-p)
             (erase-buffer)
             (insert (oj-assistant--json (vconcat tests)))
             (json-pretty-print-buffer)
             (if (fboundp 'json-mode) (json-mode) (js-json-mode))
             (setq-local oj-assistant-root root oj-assistant-problem problem oj-assistant--test-context params)
             (local-set-key (kbd "C-c C-c") #'oj-assistant-save-tests)
             (setq-local header-line-format " 编辑 input / output 字符串，可添加测试。C-c C-c 保存，C-x k 关闭")
             (set-buffer-modified-p nil)))
         (pop-to-buffer buffer))))))

(defun oj-assistant-save-tests ()
  "Validate and save the current test editor's JSON array."
  (interactive)
  (unless oj-assistant--test-context (user-error "当前窗口不是 OJ 测试编辑器"))
  (let* ((buffer (current-buffer)) (text (buffer-string))
         (value (json-parse-string text :object-type 'alist :array-type 'array
                                   :null-object nil :false-object nil)))
    (unless (vectorp value) (user-error "测试数据必须是 JSON 数组"))
    (oj-assistant--rpc
     "tests-save" (append oj-assistant--test-context `((tests . ,value)))
     (lambda (_)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (when (equal text (buffer-string)) (set-buffer-modified-p nil))))
       (message "OJ Assistant · 测试已保存")))))

(defun oj-assistant-check-tools ()
  "Check the current language's compiler/runtime."
  (interactive)
  (let ((root (oj-assistant--root))
        (language (or (and (or oj-assistant-source buffer-file-name)
                           (file-name-extension (or oj-assistant-source buffer-file-name)))
                      (oj-assistant--language))))
    (oj-assistant--rpc
     "tools" `((root . ,root) (language . ,language) (tools . ,oj-assistant-tools))
     (lambda (results)
       (oj-assistant--output root "编译环境"
                              (mapconcat (lambda (result)
                                           (format "%s  %s\n%s\n" (if (oj-assistant--get 'available result) "OK" "缺失")
                                                   (oj-assistant--get 'command result) (oj-assistant--get 'detail result))) results "\n"))))))

(defun oj-assistant-browse ()
  "Open the current problem in the browser."
  (interactive)
  (let* ((problem (or oj-assistant-problem (and (derived-mode-p 'oj-assistant-list-mode) (oj-assistant--current-row))))
         (url (oj-assistant--get 'url problem)))
    (unless (and url (string-match-p "\\`https?://" url))
      (user-error "请先打开该题的题面"))
    (browse-url url)))

(defun oj-assistant-submit ()
  "Submit an account solution or copy a link solution and open its submit page."
  (interactive)
  (let* ((source (oj-assistant--source-file)) (root (oj-assistant--root))
         (problem oj-assistant-problem) (params (oj-assistant--params)))
    (if (equal (oj-assistant--get 'kind problem) "account")
        (oj-assistant--rpc
         "account-languages" `((root . ,root) (source . ,source))
         (lambda (result)
           (let* ((choices (mapcar (lambda (choice) (cons (format "%s [%s]" (oj-assistant--get 'label choice)
                                                                      (oj-assistant--get 'value choice))
                                                        (oj-assistant--get 'value choice)))
                                   (oj-assistant--get 'choices result))))
             (unless choices (user-error "平台不支持此文件的语言"))
             (let* ((language (cdr (assoc (completing-read "提交语言 " choices nil t) choices)))
                    (id (oj-assistant--get 'id problem)))
               (when (yes-or-no-p (format "提交 %s 到 %s？ " id (oj-assistant--get 'backend problem)))
                 (message "OJ Assistant · 正在提交并等待评测…")
                 (oj-assistant--rpc
                  "submit" (append params `((source . ,source) (language . ,language)))
                  (lambda (record) (oj-assistant--show-record root record))))))))
      (kill-new (with-temp-buffer (insert-file-contents source) (buffer-string)))
      (let ((url (or (oj-assistant--get 'submitUrl problem) (oj-assistant--get 'url problem))))
        (when (and url (string-match-p "\\`https?://" url)) (browse-url url)))
      (message "OJ Assistant · 源码已复制，请在原站提交"))))

(defun oj-assistant--show-record (root record)
  (let ((verdict (oj-assistant--get 'verdict record)))
    (oj-assistant--output
     root "评测结果"
     (format "题目 %s\n账号 %s\n状态 %s\n评测 %s\n时间 %s\n内存 %s\n提交编号 %s\n\n%s\n%s\n\n可用 M-x oj-assistant-history 查看历史并继续查询。\n"
             (oj-assistant--get 'problemId record) (oj-assistant--get 'account record)
             (oj-assistant--get 'state record) (or (oj-assistant--get 'result verdict) "")
             (or (oj-assistant--get 'time verdict) "") (or (oj-assistant--get 'memory verdict) "")
             (or (oj-assistant--get 'recordId record) "") (or (oj-assistant--get 'message record) "")
             (or (oj-assistant--get 'details verdict) "")))))

(defvar oj-assistant-history-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (define-key map (kbd "RET") #'oj-assistant-history-detail)
    (define-key map (kbd "r") #'oj-assistant-resume)
    (define-key map (kbd "p") #'oj-assistant-pause)
    (define-key map (kbd "g") #'oj-assistant-history)
    (define-key map (kbd "D") #'oj-assistant-dismiss-submission)
    map))

(define-derived-mode oj-assistant-history-mode tabulated-list-mode "OJ 提交历史"
  "Submission history. RET shows details, r resumes, p pauses, D unblocks retries."
  (setq tabulated-list-format [("提交时间" 24 t) ("账号" 18 t) ("题目" 15 t)
                               ("状态" 12 t) ("评测" 25 t) ("提交编号" 18 t)]
        tabulated-list-padding 2)
  (tabulated-list-init-header))

(defun oj-assistant-history ()
  "Display this workspace's Emacs submission history."
  (interactive)
  (let ((root (oj-assistant--root)))
    (oj-assistant--rpc
     "history" `((root . ,root))
     (lambda (records)
       (let ((buffer (get-buffer-create (oj-assistant--name "提交历史" root))))
         (with-current-buffer buffer
           (oj-assistant-history-mode)
           (setq-local oj-assistant-root root oj-assistant--rows records
                       header-line-format " RET 详情  r 继续查询  p 停止等待  g 刷新  D 在原站确认后解除重交阻止")
           (setq tabulated-list-entries
                 (mapcar (lambda (record)
                           (list (oj-assistant--get 'localId record)
                                 (vector (or (oj-assistant--get 'createdAt record) "")
                                         (or (oj-assistant--get 'account record) "")
                                         (or (oj-assistant--get 'problemId record) "")
                                         (or (oj-assistant--get 'state record) "")
                                         (or (oj-assistant--get 'result (oj-assistant--get 'verdict record)) "")
                                         (or (oj-assistant--get 'recordId record) "")))) records))
           (tabulated-list-print t))
         (pop-to-buffer buffer))))))

(defun oj-assistant-history-detail ()
  "Show the selected submission's details."
  (interactive)
  (let ((record (cl-find (tabulated-list-get-id) oj-assistant--rows
                         :key (lambda (row) (oj-assistant--get 'localId row)) :test #'equal)))
    (unless record (user-error "请先选择一条提交记录"))
    (oj-assistant--show-record (oj-assistant--root) record)))

(defun oj-assistant-resume ()
  "Resume the selected submission's judgement without uploading code."
  (interactive)
  (let ((root (oj-assistant--root)) (id (tabulated-list-get-id)))
    (unless id (user-error "请在提交历史中选择一条记录"))
    (oj-assistant--rpc "resume" `((root . ,root) (id . ,id))
                       (lambda (record) (oj-assistant--show-record root record)))))

(defun oj-assistant-dismiss-submission ()
  "Explicitly acknowledge an uncertain submission to allow another upload."
  (interactive)
  (let ((root (oj-assistant--root)) (id (tabulated-list-get-id)))
    (unless id (user-error "请先选择提交记录"))
    (when (yes-or-no-p "已在原站确认该提交结果，并允许此题再次上传？ ")
      (oj-assistant--rpc "submission-dismiss" `((root . ,root) (id . ,id))
                         (lambda (_) (message "OJ Assistant · 已解除重交阻止，请刷新历史"))))))

(defun oj-assistant-pause ()
  "Stop waiting for the selected judgement. Its remote submission continues."
  (interactive)
  (let ((root (oj-assistant--root)) (id (tabulated-list-get-id)))
    (unless id (user-error "请在提交历史中选择一条记录"))
    (oj-assistant--rpc "pause" `((root . ,root) (id . ,id))
                       (lambda (_) (message "OJ Assistant · 已停止等待，可用 r 继续查询")))))

(defvar oj-assistant-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-r") #'oj-assistant-run-tests)
    (define-key map (kbd "C-c C-t") #'oj-assistant-edit-tests)
    (define-key map (kbd "C-c C-s") #'oj-assistant-submit)
    (define-key map (kbd "C-c C-o") #'oj-assistant-show-statement)
    map))

(define-minor-mode oj-assistant-mode
  "OJ solution commands. C-c C-r tests, C-c C-t edits tests, C-c C-s submits."
  :lighter " OJ" :keymap oj-assistant-mode-map)

;;;###autoload
(defun oj-assistant-maybe-enable ()
  "Restore a cached source association when visiting an OJ solution file."
  (when (and buffer-file-name (not (file-remote-p buffer-file-name)))
    (when-let* ((found (locate-dominating-file buffer-file-name ".oj-assistant"))
                (root (file-name-as-directory (expand-file-name found))))
      (when (or (string-match-p "/\\.oj-assistant/practice/" (subst-char-in-string ?\\ ?/ buffer-file-name))
                (file-exists-p (expand-file-name ".oj-assistant/emacs-sources.json" root)))
        (let ((buffer (current-buffer)) (source buffer-file-name))
          (oj-assistant--rpc
           "source-info" `((root . ,root) (source . ,source))
           (lambda (info)
             (when (and info (buffer-live-p buffer))
               (oj-assistant--rpc
                "problem" (append `((root . ,root)) info)
                (lambda (problem)
                  (when (buffer-live-p buffer)
                    (with-current-buffer buffer
                      (setq-local oj-assistant-root root oj-assistant-problem problem oj-assistant-source source)
                      (oj-assistant-mode 1)))))))))))))

(defvar oj-assistant-command-map
  (let ((map (make-sparse-keymap)))
    (dolist (binding '(("o" . oj-assistant) ("i" . oj-assistant-import-url)
                       ("I" . oj-assistant-import-json) ("r" . oj-assistant-run-tests)
                       ("t" . oj-assistant-edit-tests) ("s" . oj-assistant-submit)
                       ("p" . oj-assistant-show-statement) ("l" . oj-assistant-login)
                       ("L" . oj-assistant-select-language) ("b" . oj-assistant-browse)
                       ("h" . oj-assistant-history) ("c" . oj-assistant-check-tools)))
      (define-key map (kbd (car binding)) (cdr binding)))
    map)
  "Prefix commands intended for C-c j.")

(provide 'oj-assistant)
;;; oj-assistant.el ends here
