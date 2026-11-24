;;; oj-assistant-tests.el --- Frontend regression checks -*- lexical-binding: t; coding: utf-8; -*-

(require 'ert)
(require 'oj-assistant)
(set-default-coding-systems 'utf-8-unix)

(defun oj-test-wait (predicate)
  (let ((deadline (+ (float-time) 15)))
    (while (and (not (funcall predicate)) (< (float-time) deadline))
      (accept-process-output nil 0.02)
      (sit-for 0.01))
    (should (funcall predicate))))

(defun oj-test-call (method params)
  (let (done result failure)
    (oj-assistant--rpc method params
                       (lambda (value) (setq result value done t))
                       (lambda (error-text) (setq failure error-text done t)))
    (oj-test-wait (lambda () done))
    (when failure (error "%s" failure))
    result))

(defmacro oj-test-workspace (&rest body)
  (declare (indent 0) (debug t))
  `(let* ((root (file-name-as-directory (make-temp-file "oj-emacs-中文 空格-" t)))
          (oj-assistant--last-root root)
          (original-buffers (buffer-list)))
     (unwind-protect
         (progn ,@body)
       (dolist (buffer (cl-set-difference (buffer-list) original-buffers))
         (with-current-buffer buffer (set-buffer-modified-p nil))
         (kill-buffer buffer))
       (delete-directory root t))))

(defun oj-test-import (root)
  (let ((file (expand-file-name "题目.json" root)))
    (with-temp-file file
      (insert (oj-assistant--json
               '((name . "求和 A+B") (url . "https://www.luogu.com.cn/problem/P1001")
                 (statement . "# 题目描述\n输入两个整数，输出它们的和。")
                 (tests . [((input . "1 2\n") (output . "3\n"))])))))
    (car (oj-test-call "practice-json" `((root . ,root) (file . ,file))))))

(ert-deftest oj-json-protocol-unicode-and-fragmented-lines ()
  (let* ((process (make-pipe-process :name "oj-test-framing" :noquery t))
         (oj-assistant--requests (make-hash-table :test #'eql))
         result done)
    (unwind-protect
        (progn
          (puthash 123 (cons (lambda (value) (setq result value done t)) #'error) oj-assistant--requests)
          (oj-assistant--filter process "{\"id\":123,\"result\":{\"title\":\"中文")
          (should-not done)
          (oj-assistant--filter process " 题面\"}}\n")
          (oj-test-wait (lambda () done))
          (should (equal (oj-assistant--get 'title result) "中文 题面"))
          (should (= (hash-table-count oj-assistant--requests) 0)))
      (delete-process process))))

(ert-deftest oj-real-service-and-error-response ()
  (should (= (length (oj-assistant--get 'platforms (oj-test-call "hello" nil))) 9))
  (oj-test-workspace
    (should-error (oj-test-call "practice-open" `((root . ,root) (key . "../bad"))))))

(ert-deftest oj-native-library-statement-and-language-preservation ()
  (oj-test-workspace
    (let* ((problem (oj-test-import root))
           (opened (oj-test-call "practice-open" `((root . ,root) (key . ,(oj-assistant--get 'key problem)) (language . "cpp"))))
           (source (oj-assistant--get 'source opened)))
      (save-window-excursion
        (oj-assistant root)
        (oj-test-wait (lambda () (= (length oj-assistant--rows) 1)))
        (should (string-match-p "求和" (buffer-string)))
        (oj-assistant--open-result root opened)
        (should (= (length (window-list)) 2))
        (should oj-assistant-mode)
        (should (file-equal-p buffer-file-name source))
        (let ((statement (get-buffer (oj-assistant--name "题面" root))))
          (should (get-buffer-window statement))
          (with-current-buffer statement
            (should (derived-mode-p 'oj-assistant-statement-mode))
            (should (string-match-p "输入两个整数" (buffer-string)))
            (should (string-match-p "样例 1" (buffer-string)))
            (should-not (string-match-p "<h2>" (buffer-string)))))
        (erase-buffer) (insert "// existing solution\n") (save-buffer)
        (select-window (get-buffer-window (get-buffer (oj-assistant--name "题面" root))))
        (oj-assistant-select-language "py")
        (oj-test-wait (lambda () (find-buffer-visiting (concat (file-name-sans-extension source) ".py"))))
        (should (get-buffer-window (find-buffer-visiting (concat (file-name-sans-extension source) ".py"))))
        (should (file-exists-p source))
        (should (equal (with-temp-buffer (insert-file-contents source) (buffer-string)) "// existing solution\n"))))))

(ert-deftest oj-tests-editor-save-and-real-run ()
  (oj-test-workspace
    (let* ((problem (oj-test-import root))
           (opened (oj-test-call "practice-open" `((root . ,root) (key . ,(oj-assistant--get 'key problem)) (language . "js"))))
           (source (oj-assistant--get 'source opened)))
      (save-window-excursion
        (oj-assistant--open-result root opened)
        (erase-buffer) (insert "console.log(3);\n") (save-buffer)
        (oj-assistant-edit-tests)
        (let ((name (format "*OJ 测试 · %s · %s*" (oj-assistant--get 'key problem) (substring (secure-hash 'sha1 root) 0 6))))
          (oj-test-wait (lambda () (get-buffer name)))
          (with-current-buffer name
            (should oj-assistant--test-context)
            (erase-buffer)
            (insert "[{\"input\":\"1 2\\n\",\"output\":\"3\\n\"}]")
            (oj-assistant-save-tests))
          (oj-test-wait (lambda () (not (buffer-modified-p (get-buffer name))))))
        (with-current-buffer (find-buffer-visiting source)
          (oj-assistant-run-tests))
        (let ((output (oj-assistant--name "测试结果" root)))
          (oj-test-wait (lambda () (get-buffer output)))
          (with-current-buffer output
            (should (string-match-p "1 / 1 通过" (buffer-string)))
            (should (string-match-p "预期输出" (buffer-string)))))))))

(ert-deftest oj-source-association-restores-without-network ()
  (oj-test-workspace
    (let* ((problem (oj-test-import root))
           (opened (oj-test-call "practice-open" `((root . ,root) (key . ,(oj-assistant--get 'key problem)))))
           (buffer (find-file-noselect (oj-assistant--get 'source opened))))
      (with-current-buffer buffer
        (should (locate-dominating-file buffer-file-name ".oj-assistant"))
        (should (string-match-p "/\\.oj-assistant/practice/" (subst-char-in-string ?\\ ?/ buffer-file-name)))
        (oj-assistant-maybe-enable)
        (oj-test-wait (lambda () (buffer-local-value 'oj-assistant-mode buffer)))
        (should (equal (oj-assistant--get 'key oj-assistant-problem) (oj-assistant--get 'key problem)))))))

(ert-deftest oj-test-editor-rejects-json-object ()
  (with-temp-buffer
    (setq-local oj-assistant--test-context '((root . "unused")))
    (insert "{}")
    (should-error (oj-assistant-save-tests) :type 'user-error)))

(ert-deftest oj-local-config-binds-standard-prefix ()
  (let ((file (expand-file-name "user-lisp/init-oj-assistant.el" user-emacs-directory)))
    (unless (file-readable-p file) (ert-skip "Local integration is specific to this Emacs configuration"))
    (load file nil t))
  (should (eq (key-binding (kbd "C-c j o")) #'oj-assistant))
  (should (memq #'oj-assistant-maybe-enable find-file-hook)))

;;; oj-assistant-tests.el ends here
